import type { ExecResult } from '../sandbox/types.js';

export interface NetworkApiFailure {
  message: string;
  evidence: string;
}

const FAILURE_LINE_RE =
  /\b(?:network|api|http|https|request|requests|fetch|connection|dns|ssl|tls|socket|timed out|status code|client error|server error)\b.*\b(?:fail(?:ed|ure)?|error|timed out|timeout(?:\s+(?:exceeded|after|while|connecting|reading))|refused|reset|unreachable|unavailable|forbidden|unauthorized|not found|too many requests|bad gateway|service unavailable)\b|\b(?:fail(?:ed|ure)?|error|timed out|timeout(?:\s+(?:exceeded|after|while|connecting|reading))|refused|reset|unreachable|unavailable)\b.*\b(?:network|api|http|https|request|requests|fetch|connection|dns|ssl|tls|socket)\b|(?:网络|接口|API|HTTP|请求|连接|超时|限流|不可用)[^\n]{0,80}(?:失败|错误|异常|超时|拒绝|不可达|不可用|限流)|(?:失败|错误|异常|超时|拒绝|不可达|不可用|限流)[^\n]{0,80}(?:网络|接口|API|HTTP|请求|连接|服务)/iu;

const EXCEPTION_RE =
  /\b(?:ConnectionError|Timeout|ReadTimeout|ConnectTimeout|HTTPError|SSLError|ProxyError|TooManyRedirects|MaxRetryError|NameResolutionError|gaierror|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)\b/u;

const HTTP_STATUS_RE = /\b(?:HTTP\s*)?(?:status(?:\s*code)?\s*[=:]?\s*)?(?:401|403|404|408|409|425|429|5\d\d)\b[^\n]{0,80}\b(?:api|http|request|fetch|接口|请求)\b|\b(?:api|http|request|fetch|接口|请求)\b[^\n]{0,80}\b(?:401|403|404|408|409|425|429|5\d\d)\b/iu;

export function detectNetworkApiFailure(text: string): NetworkApiFailure | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isTestRunnerStatusLine(line)) continue;
    if (isTestAssertionDiagnosticLine(line)) continue;
    if (FAILURE_LINE_RE.test(line) || EXCEPTION_RE.test(line) || HTTP_STATUS_RE.test(line)) {
      return {
        message:
          'Network API failure detected. Treat this task as failed and select a reachable, suitable API or fix the API integration.',
        evidence: line.slice(0, 500),
      };
    }
  }
  return null;
}

export function isTestAssertionDiagnosticLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (/^\d+\|\s/u.test(text)) return true;
  if (/^(?:[→>-]\s*)?expected\b/iu.test(text)) return true;
  if (/\bAssertionError\b/iu.test(text) && /\bexpected\b/iu.test(text)) return true;
  if (/\bexpect\s*\(/u.test(text) && /\.(?:to|not)\w*\s*\(/u.test(text)) return true;
  return /\bexpected\b[\s\S]{0,240}\b(?:got|received|to\s+(?:be|equal|throw|contain|have|match))\b/iu.test(text);
}

function isTestRunnerStatusLine(line: string): boolean {
  if (/^[✓✔]\s/u.test(line) || /\bPASSED\b/u.test(line) || /\bPASS\b\s+[\w./:-]+/u.test(line)) {
    return true;
  }
  return /^(?:FAIL|FAILED|×|✕|✖)\s+[\w./:-]+(?:\s*::|\s+>|\s+\(|\s*$)/u.test(line) ||
    /^❯\s+[\w./:-]+(?:\s*::|\s+>|\s+\(|\s*$)/u.test(line);
}

export function detectNetworkApiFailureInExec(result: ExecResult): NetworkApiFailure | null {
  return detectNetworkApiFailure(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
}
