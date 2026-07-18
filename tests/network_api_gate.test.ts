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

  it('does not treat passing test names about network errors as real API failures', () => {
    const vitest = detectNetworkApiFailure(
      '✓ tests/unit/crawler.test.ts > M001 Crawler > fetchPage 网络错误抛出错误',
    );
    const pytest = detectNetworkApiFailure(
      'PASSED tests/test_api.py::test_fetch_handles_network_error',
    );
    expect(vitest).toBeNull();
    expect(pytest).toBeNull();
  });

  it('does not treat failing test titles about network errors as real API failures', () => {
    const vitest = detectNetworkApiFailure(
      'FAIL  tests/unit/crawler.test.ts > M001 Crawler > fetchPage 网络错误抛出错误',
    );
    const vitestCross = detectNetworkApiFailure(
      '× tests/unit/crawler.test.ts > M001 Crawler > fetchPage network error is handled',
    );
    const pytest = detectNetworkApiFailure(
      'FAILED tests/test_api.py::test_fetch_handles_network_error - AssertionError: expected fallback',
    );
    expect(vitest).toBeNull();
    expect(vitestCross).toBeNull();
    expect(pytest).toBeNull();
  });

  it('does not treat test assertion diagnostics with mocked HTTP status text as real API failures', () => {
    const vitest = detectNetworkApiFailure(
      "AssertionError: expected [Function] to throw error matching /Failed to fetch/ but got 'Request failed with status code 404'",
    );
    const pretty = detectNetworkApiFailure(
      "   → expected 'Request failed with status code 404' to contain 'Failed to fetch'",
    );
    expect(vitest).toBeNull();
    expect(pretty).toBeNull();
  });
});
