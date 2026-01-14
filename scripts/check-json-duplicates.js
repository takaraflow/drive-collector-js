import fs from 'fs';
import path from 'path';
import process from 'process';

function parseString(text, startIndex) {
  let index = startIndex + 1; // skip opening quote
  let result = '';
  while (index < text.length) {
    const ch = text[index];
    if (ch === '"') {
      return { value: result, end: index + 1 };
    }
    if (ch === '\\') {
      const next = text[index + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = text.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          index += 6;
          continue;
        }
      }
      const escapes = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t'
      };
      result += escapes[next] ?? next;
      index += 2;
      continue;
    }
    result += ch;
    index += 1;
  }
  throw new Error('Unterminated string');
}

function skipWhitespace(text, index) {
  while (index < text.length) {
    const ch = text[index];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') index += 1;
    else break;
  }
  return index;
}

function detectDuplicateKeys(jsonText) {
  const duplicates = [];
  const stack = [];
  let index = 0;

  const currentPath = () => {
    const segments = [];
    for (const frame of stack) {
      if (frame.pathSegment !== null && frame.pathSegment !== undefined) {
        segments.push(String(frame.pathSegment).replace(/~/g, '~0').replace(/\//g, '~1'));
      }
    }
    return '/' + segments.join('/');
  };

  const pushFrame = (type, pathSegment) => {
    stack.push({
      type,
      keys: type === 'object' ? new Set() : null,
      state: type === 'object' ? 'expectKeyOrEnd' : 'expectValueOrEnd',
      pendingKey: null,
      pathSegment: pathSegment ?? null
    });
  };

  const popFrame = () => {
    stack.pop();
  };

  const markValueComplete = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (top.type === 'object') top.state = 'expectCommaOrEnd';
    else top.state = 'expectCommaOrEnd';
  };

  while (index < jsonText.length) {
    index = skipWhitespace(jsonText, index);
    const ch = jsonText[index];
    if (ch === undefined) break;

    const top = stack[stack.length - 1];

    if (!top) {
      if (ch === '{') {
        pushFrame('object', null);
        index += 1;
        continue;
      }
      if (ch === '[') {
        pushFrame('array', null);
        index += 1;
        continue;
      }
      throw new Error(`Invalid JSON start token: ${ch}`);
    }

    if (top.type === 'object') {
      if (top.state === 'expectKeyOrEnd') {
        if (ch === '}') {
          popFrame();
          index += 1;
          markValueComplete();
          continue;
        }
        if (ch === '"') {
          const parsed = parseString(jsonText, index);
          const key = parsed.value;
          if (top.keys.has(key)) {
            duplicates.push({ path: `${currentPath()}/${key}`, key });
          } else {
            top.keys.add(key);
          }
          top.pendingKey = key;
          top.state = 'expectColon';
          index = parsed.end;
          continue;
        }
        throw new Error(`Expected object key at ${index}`);
      }
      if (top.state === 'expectColon') {
        if (ch !== ':') throw new Error(`Expected ':' after key at ${index}`);
        top.state = 'expectValue';
        index += 1;
        continue;
      }
      if (top.state === 'expectValue') {
        if (ch === '{') {
          const seg = top.pendingKey;
          top.pendingKey = null;
          top.state = 'expectCommaOrEnd';
          pushFrame('object', seg);
          index += 1;
          continue;
        }
        if (ch === '[') {
          const seg = top.pendingKey;
          top.pendingKey = null;
          top.state = 'expectCommaOrEnd';
          pushFrame('array', seg);
          index += 1;
          continue;
        }
        if (ch === '"') {
          const parsed = parseString(jsonText, index);
          top.pendingKey = null;
          top.state = 'expectCommaOrEnd';
          index = parsed.end;
          continue;
        }
        // primitives: true/false/null/number
        top.pendingKey = null;
        top.state = 'expectCommaOrEnd';
        // skip until delimiter at same nesting level
        while (index < jsonText.length) {
          const c = jsonText[index];
          if (c === ',' || c === '}' || c === ']' || c === '\n' || c === '\r' || c === '\t' || c === ' ') break;
          index += 1;
        }
        continue;
      }
      if (top.state === 'expectCommaOrEnd') {
        if (ch === ',') {
          top.state = 'expectKeyOrEnd';
          index += 1;
          continue;
        }
        if (ch === '}') {
          popFrame();
          index += 1;
          markValueComplete();
          continue;
        }
        // allow whitespace handled at loop top
        throw new Error(`Expected ',' or '}' at ${index}`);
      }
    } else {
      // array
      if (top.state === 'expectValueOrEnd') {
        if (ch === ']') {
          popFrame();
          index += 1;
          markValueComplete();
          continue;
        }
        if (ch === '{') {
          top.state = 'expectCommaOrEnd';
          pushFrame('object', String(top.index ?? 0));
          top.index = (top.index ?? 0) + 1;
          index += 1;
          continue;
        }
        if (ch === '[') {
          top.state = 'expectCommaOrEnd';
          pushFrame('array', String(top.index ?? 0));
          top.index = (top.index ?? 0) + 1;
          index += 1;
          continue;
        }
        if (ch === '"') {
          const parsed = parseString(jsonText, index);
          top.state = 'expectCommaOrEnd';
          top.index = (top.index ?? 0) + 1;
          index = parsed.end;
          continue;
        }
        // primitives
        top.state = 'expectCommaOrEnd';
        top.index = (top.index ?? 0) + 1;
        while (index < jsonText.length) {
          const c = jsonText[index];
          if (c === ',' || c === ']' || c === '}' || c === '\n' || c === '\r' || c === '\t' || c === ' ') break;
          index += 1;
        }
        continue;
      }
      if (top.state === 'expectCommaOrEnd') {
        if (ch === ',') {
          top.state = 'expectValueOrEnd';
          index += 1;
          continue;
        }
        if (ch === ']') {
          popFrame();
          index += 1;
          markValueComplete();
          continue;
        }
        throw new Error(`Expected ',' or ']' at ${index}`);
      }
    }
  }

  return duplicates;
}

function main() {
  const filePath = process.argv[2] || 'manifest.json';
  const absolutePath = path.resolve(process.cwd(), filePath);
  const content = fs.readFileSync(absolutePath, 'utf8');

  const duplicates = detectDuplicateKeys(content);
  if (duplicates.length) {
    console.error(`[json-duplicates] Found ${duplicates.length} duplicate key(s) in ${filePath}:`);
    duplicates.slice(0, 50).forEach(d => console.error(`- ${d.path}`));
    if (duplicates.length > 50) {
      console.error(`...and ${duplicates.length - 50} more`);
    }
    process.exit(1);
  }

  console.log(`[json-duplicates] OK: no duplicate keys in ${filePath}`);
}

main();

