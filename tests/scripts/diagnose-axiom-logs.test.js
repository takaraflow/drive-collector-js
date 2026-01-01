import { jest } from '@jest/globals';

// Mock IO
jest.unstable_mockModule('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    existsSync: jest.fn(),
  };
});

jest.unstable_mockModule('dotenv', () => ({
  default: {
    config: jest.fn()
  }
}));

jest.unstable_mockModule('@axiomhq/js', () => ({
  Axiom: jest.fn().mockImplementation(() => ({
    query: jest.fn()
  }))
}));

const fs = await import('fs');
const dotenv = (await import('dotenv')).default;
const { runDiagnosis, parseArgs } = await import('../../scripts/diagnose-axiom-logs.js');

describe('diagnose-axiom-logs.js', () => {
  let consoleLogSpy;
  let consoleErrorSpy;
  let mockAxiomClient;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    // Reset mocks
    jest.clearAllMocks();
    
    fs.existsSync.mockReturnValue(false);
    dotenv.config.mockReturnValue({});

    mockAxiomClient = {
      query: jest.fn()
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('parseArgs should handle default values', () => {
    // Note: yargs might behave differently with hideBin in tests if process.argv is not what it expects
    // We pass an empty array but yargs(hideBin([])) results in something that might be weird.
    // Better to pass a dummy command line
    const argv = parseArgs(['node', 'script.js']);
    expect(argv.hours).toBe(1);
    expect(argv['env-file']).toBe('.env');
  });

  test('parseArgs should handle custom values', () => {
    const argv = parseArgs(['node', 'script.js', '--hours', '5', '--dataset', 'my-dataset', '--env-file', '.env.prod']);
    expect(argv.hours).toBe(5);
    expect(argv.dataset).toBe('my-dataset');
    expect(argv['env-file']).toBe('.env.prod');
  });

  test('runDiagnosis should throw if AXIOM_TOKEN is missing', async () => {
    const argv = parseArgs(['node', 'script.js']);
    await expect(runDiagnosis({
      argv,
      env: {},
      axiomClient: mockAxiomClient
    })).rejects.toThrow('Missing AXIOM_TOKEN or DATASET');
    
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error: AXIOM_TOKEN and AXIOM_DATASET must be provided'));
  });

  test('runDiagnosis should load dotenv if file exists', async () => {
    fs.existsSync.mockReturnValue(true);
    const argv = parseArgs(['node', 'script.js', '--env-file', '.env.test']);
    
    try {
      await runDiagnosis({
        argv,
        env: { AXIOM_TOKEN: 'test-token', AXIOM_DATASET: 'test-ds' },
        axiomClient: mockAxiomClient
      });
    } catch (e) {
      // ignore
    }

    expect(dotenv.config).toHaveBeenCalledWith({ path: '.env.test' });
  });

  test('runDiagnosis should process logs and generate report correctly', async () => {
    const mockMatches = [
      { data: { message: 'NF Redis hit', status: 200, duration: 10 } },
      { data: { message: 'NF fail', status: 500, duration: 20 } },
      { data: { message: 'fallback to KV', status: 200, duration: 15 } },
      { data: { message: 'KV quota exceeded', status: 429, duration: 5 } },
      { data: { message: 'some other log', status: 200, duration: 12 } }
    ];

    mockAxiomClient.query.mockResolvedValue({ matches: mockMatches });

    const argv = parseArgs(['node', 'script.js', '--hours', '2']);
    await runDiagnosis({
      argv,
      env: { AXIOM_TOKEN: 'test-token', AXIOM_DATASET: 'test-ds' },
      axiomClient: mockAxiomClient
    });

    // Verify query
    expect(mockAxiomClient.query).toHaveBeenCalledWith(expect.stringContaining("['test-ds']"));
    expect(mockAxiomClient.query).toHaveBeenCalledWith(expect.stringContaining("where _time > datetime(2026-01-01T10:00:00.000Z)"));

    // Verify report output
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Total Relevant Logs: 5'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NF Success Rate: 50.00% (1/2)'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Fallback Occurrences: 1'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('CF KV Quota Exceeded: 1'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Average Duration: 12.40ms'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Top Error Codes:'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- 500: 1x'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('- 429: 1x'));
  });

  test('runDiagnosis should handle empty results', async () => {
    mockAxiomClient.query.mockResolvedValue({ matches: [] });

    const argv = parseArgs(['node', 'script.js']);
    await runDiagnosis({
      argv,
      env: { AXIOM_TOKEN: 'test-token', AXIOM_DATASET: 'test-ds' },
      axiomClient: mockAxiomClient
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('No relevant logs found'));
  });

  test('runDiagnosis should handle API error', async () => {
    const apiError = new Error('API Failed');
    mockAxiomClient.query.mockRejectedValue(apiError);

    const argv = parseArgs(['node', 'script.js']);
    await expect(runDiagnosis({
      argv,
      env: { AXIOM_TOKEN: 'test-token', AXIOM_DATASET: 'test-ds' },
      axiomClient: mockAxiomClient
    })).rejects.toThrow('API Failed');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error querying Axiom:'), 'API Failed');
  });

  test('runDiagnosis should handle logs without duration or message', async () => {
    const mockMatches = [
      { data: { status: 200 } } // Missing message and duration
    ];

    mockAxiomClient.query.mockResolvedValue({ matches: mockMatches });

    const argv = parseArgs(['node', 'script.js']);
    await runDiagnosis({
      argv,
      env: { AXIOM_TOKEN: 'test-token', AXIOM_DATASET: 'test-ds' },
      axiomClient: mockAxiomClient
    });

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Total Relevant Logs: 1'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('NF Success Rate: N/A'));
  });
});
