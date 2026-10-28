import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canProvisionChurch } from '../lib/provisioning-security.ts';

describe('church provisioning authorization policy', () => {
  it('allows an authenticated user without an existing profile to request atomic provisioning', () => {
    assert.equal(canProvisionChurch(null), true);
  });

  it('allows only an unlinked pastor profile to provision a church', () => {
    assert.equal(canProvisionChurch({ tenant_id: null, role: 'pastor' }), true);
    // Shared table: SACCOS default is member -> must be allowed to upgrade to pastor for church
    assert.equal(canProvisionChurch({ tenant_id: null, role: 'member' }), true);
    assert.equal(canProvisionChurch({ tenant_id: 'tenant-a', role: 'pastor' }), false);
    assert.equal(canProvisionChurch({ tenant_id: null, role: 'admin' }), false);
    assert.equal(canProvisionChurch({ tenant_id: null, role: 'staff' }), false);
    assert.equal(canProvisionChurch({ tenant_id: null, role: 'overseer' }), false);
  });

  it('does not fall back to privileged direct table writes when provisioning fails', () => {
    const source = readFileSync(new URL('../lib/provision-actions.ts', import.meta.url), 'utf8');
    assert.match(source, /\.rpc\('provision_church_v3'/);
    assert.doesNotMatch(source, /\.from\(['\"]churches['\"]\)\s*\.(?:insert|upsert)/);
    assert.doesNotMatch(source, /\.from\(['\"]admin_profiles['\"]\)\s*\.(?:insert|upsert)/);
  });
});
