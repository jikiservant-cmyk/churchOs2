import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { 
  getPublicDenominations, 
  getDenominationBranding, 
  getMyLoginContext,
  parseLoginContext,
  validateProvisionV3Payload,
  normalizeInviteCode
} from '../lib/denomination.ts';
import type { LoginContext, PublicDenomination } from '../lib/denomination.ts';

describe('Denomination RPC & Helper Suite', () => {
  describe('normalizeInviteCode()', () => {
    it('trims and uppercases input code', () => {
      assert.equal(normalizeInviteCode('  grace-2026-x8  '), 'GRACE-2026-X8');
      assert.equal(normalizeInviteCode(null), '');
      assert.equal(normalizeInviteCode(''), '');
    });
  });

  describe('validateProvisionV3Payload()', () => {
    it('accepts valid 5-parameter payload without p_ip', () => {
      const validPayload = {
        p_user_id: 'usr_abc_123',
        p_name: 'Grace Cathedral',
        p_slug: 'grace-cathedral',
        p_role: 'pastor',
        p_invite_code: 'GRACE-2026',
      };

      const result = validateProvisionV3Payload(validPayload);
      assert.equal(result.valid, true);
    });

    it('accepts a valid p_ip (stored for the per-IP scam guard)', () => {
      const payloadWithIp = {
        p_user_id: 'usr_abc_123',
        p_name: 'Grace Cathedral',
        p_slug: 'grace-cathedral',
        p_role: 'pastor',
        p_invite_code: 'GRACE-2026',
        p_ip: '197.232.1.1',
      };

      const result = validateProvisionV3Payload(payloadWithIp);
      assert.equal(result.valid, true);
    });

    it('rejects a malformed p_ip', () => {
      const invalidPayload = {
        p_user_id: 'usr_abc_123',
        p_name: 'Grace Cathedral',
        p_slug: 'grace-cathedral',
        p_role: 'pastor',
        p_invite_code: 'GRACE-2026',
        p_ip: 'not-an-ip',
      };

      const result = validateProvisionV3Payload(invalidPayload);
      assert.equal(result.valid, false);
      assert.match(result.error || '', /p_ip/);
    });

    it('rejects payload with invalid role', () => {
      const invalidPayload = {
        p_user_id: 'usr_abc_123',
        p_name: 'Grace Cathedral',
        p_slug: 'grace-cathedral',
        p_role: 'member',
        p_invite_code: null,
      };

      const result = validateProvisionV3Payload(invalidPayload);
      assert.equal(result.valid, false);
    });
  });

  describe('parseLoginContext()', () => {
    it('correctly maps overseer context row', () => {
      const row = [{
        account_type: 'overseer',
        denomination_id: 'denom_456',
        denomination_name: 'Anglican Diocese of Kampala',
        denomination_slug: 'adk',
        role: 'overseer',
      }];

      const parsed = parseLoginContext(row);
      assert.ok(parsed);
      assert.equal(parsed.account_type, 'overseer');
      assert.equal(parsed.denomination_name, 'Anglican Diocese of Kampala');
      assert.equal(parsed.denomination_slug, 'adk');
    });

    it('correctly maps pastor context row with church', () => {
      const row = [{
        account_type: 'pastor',
        church_id: 'church_101',
        church_name: 'Grace Chapel',
        church_slug: 'grace-chapel',
        denomination_id: null,
        denomination_name: null,
        role: 'pastor',
      }];

      const parsed = parseLoginContext(row);
      assert.ok(parsed);
      assert.equal(parsed.account_type, 'pastor');
      assert.equal(parsed.church_slug, 'grace-chapel');
      assert.equal(parsed.denomination_slug, null);
    });

    it('handles null or empty input safely', () => {
      assert.equal(parseLoginContext(null), null);
      assert.equal(parseLoginContext([]), null);
    });
  });

  describe('getPublicDenominations() with mock client', () => {
    it('returns empty array when query returns no rows or error', async () => {
      const mockClient = {
        from: () => ({
          select: () => ({
            order: async () => ({ data: [], error: null })
          })
        })
      };

      const denoms = await getPublicDenominations(mockClient);
      assert.deepEqual(denoms, []);
    });

    it('returns rows when query succeeds', async () => {
      const expected = [{
        slug: 'presbyterian-fellowship',
        name: 'Presbyterian Fellowship',
        logo_url: 'https://example.com/logo.png',
        primary_color: '#1E3A8A'
      }];

      const mockClient = {
        from: () => ({
          select: () => ({
            order: async () => ({ data: expected, error: null })
          })
        })
      };

      const denoms = await getPublicDenominations(mockClient);
      assert.deepEqual(denoms, expected);
    });
  });

  describe('getDenominationBranding() with mock client', () => {
    it('returns null safely for empty slug without calling rpc', async () => {
      const branding = await getDenominationBranding('');
      assert.equal(branding, null);
    });

    it('maps branding row properly', async () => {
      const mockClient = {
        rpc: async (fn: string, params: any) => {
          assert.equal(fn, 'get_denomination_branding');
          assert.equal(params.p_slug, 'anglican-uganda');
          return {
            data: [{
              id: 'denom_1',
              name: 'Church of Uganda',
              slug: 'anglican-uganda',
              logo_url: 'https://example.com/cou.png',
              primary_color: '#7C2D12',
              tagline: 'Faithful in All Generations',
            }],
            error: null,
          };
        }
      };

      const branding = await getDenominationBranding('ANGLICAN-UGANDA', mockClient);
      assert.ok(branding);
      assert.equal(branding.name, 'Church of Uganda');
      assert.equal(branding.slug, 'anglican-uganda');
      assert.equal(branding.primary_color, '#7C2D12');
    });
  });
});
