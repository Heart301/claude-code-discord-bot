import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from '../../src/utils/attachments.js';

describe('sanitizeFilename', () => {
  it('keeps a simple safe filename unchanged', () => {
    expect(sanitizeFilename('screenshot.png')).toBe('screenshot.png');
  });

  it('strips directory components to prevent path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('strips absolute path components', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
  });

  it('replaces disallowed characters with underscores', () => {
    expect(sanitizeFilename('my file@name!.png')).toBe('my_file_name_.png');
  });

  it('falls back to an underscore for an empty result', () => {
    expect(sanitizeFilename('...')).toBe('...');
    expect(sanitizeFilename('')).toBe('_');
  });
});
