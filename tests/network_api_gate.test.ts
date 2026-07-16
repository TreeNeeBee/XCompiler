import { describe, expect, it } from 'vitest';
import { detectNetworkApiFailure } from '../src/core/network_api_gate.js';

describe('detectNetworkApiFailure', () => {
  it('does not treat requests.get timeout parameters as network failures', () => {
    const log = `
      response = requests.get(url, params=params, timeout=10)
      E   ValueError: No upcoming holidays found in the next 30 days.
    `;
    expect(detectNetworkApiFailure(log)).toBeNull();
  });

  it('detects explicit HTTP/API failures', () => {
    const failure = detectNetworkApiFailure(
      'Weather API request failed: 503 Service Unavailable for url: https://weather.example/v1',
    );
    expect(failure?.evidence).toContain('503');
  });

  it('detects DNS and transport exceptions', () => {
    const failure = detectNetworkApiFailure(
      "requests.exceptions.ConnectionError: NameResolutionError: Failed to resolve 'api.example.test'",
    );
    expect(failure?.evidence).toContain('NameResolutionError');
  });
});
