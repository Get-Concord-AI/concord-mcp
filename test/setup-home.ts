import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the machine-wide store (~/.concord) at a throwaway home for every test
// file. Tests that need a particular home still set HOME themselves; none may
// read or migrate the developer's real global store.
const home = mkdtempSync(join(tmpdir(), 'concord-test-home-'));
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
