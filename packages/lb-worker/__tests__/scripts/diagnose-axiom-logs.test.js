import { vi, describe, test, expect, beforeEach, afterEach, afterAll } from 'vitest';

// Mock IO
vi.mock('fs', async () => {
  const actual = await import('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('dotenv', async () => {
  const actual = await import('dotenv');
  return {
    ...actual,
    default: {
      config: vi.fn()
    }
  };
});

vi.mock('@axiomhq/js', async () => {
  const actual = await import('@axiomhq/js');
  return {
    ...actual,
    Axiom: vi.fn().mockImplementation(() => ({
      query: vi.fn()
    }))
  };
});

const fs = await import('fs');
const dotenv = (await import('dotenv')).default;
const { runDiagnosis, parseArgs } = await import('../../scripts/diagnose-axiom-logs.js');

describe('diagnose-axiom-logs.js', () => {
  let consoleLogSpy;
  let consoleErrorSpy;
  let mockAxiomClient;

  beforeEach(() => {
    // Use global fake timers from setup, but set system time for this test
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Reset mocks
    vi.clearAllMocks();
    
    fs.existsSync.mockReturnValue(false);
    dotenv.config.mockReturnValue({});

    mockAxiomClient = {
      query: vi.fn()
    };
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.clearAllTimers();
  });

  test('should_parse_args_with_default_values', () => {
    // Note: yargs might behave differently with hideBin in tests if process.argv is not what it expects
    // We pass an empty array but yargs(hideBin([])) results in something that might be weird.
    // Better to pass a dummy command line
    const argv = parseArgs(['node', 'script.js']);
    expect(argv.hours).toBe(1);
    expect(argv['env-file']).toBe('.env');
  });

  test('should_parse_args_with_custom_values', () => {
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

  test('should_process_logs_and_generate_diagnosis_report', async () => {
    const mockMatches = [
      { data: { message: 'Redis TLS hit', status: 200, duration: 10 } },
      { data: { message: 'Redis TLS fail', status: 500, duration: 20 } },
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

    // Verify report output - check all console.log calls
    const calls = consoleLogSpy.mock.calls.flat();
    const output = calls.join('\n');
    
    expect(output).toContain('Total Relevant Logs: 5');
    expect(output).toContain('REDIS TLS Success Rate: 50.00% (1/2)');
    expect(output).toContain('Fallback Occurrences: 1');
    expect(output).toContain('CF KV Quota Exceeded: 1');
    expect(output).toContain('Average Duration: 12.40ms');
    expect(output).toContain('Top Error Codes:');
    expect(output).toContain('- 500: 1x');
    expect(output).toContain('- 429: 1x');
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
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('REDIS TLS Success Rate: N/A'));
  });
});
