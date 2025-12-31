import Sequencer from '@jest/test-sequencer';
import fs from 'fs';

class CustomSequencer extends Sequencer.default {
  /**
   * Sort tests so that smaller files (likely faster) run first.
   * This helps reduce tail latency.
   */
  sort(tests) {
    const copy = Array.from(tests);
    return copy.sort((testA, testB) => {
      const sizeA = fs.statSync(testA.path).size;
      const sizeB = fs.statSync(testB.path).size;
      if (sizeA !== sizeB) {
        return sizeB - sizeA; // Sort by size DESC (slowest first)
      }
      return testA.path.localeCompare(testB.path);
    });
  }
}

export default CustomSequencer;
