import chalk from 'chalk';
import type { AuditLogger } from '../audit/audit.js';
import { t } from '../i18n/index.js';
import type { LLMRouter } from './router.js';

export interface RoleModelAdvice {
  coder: { provider: string; model: string };
  debugger: { provider: string; model: string };
}

export function findSharedCoderDebuggerModel(router: LLMRouter): RoleModelAdvice | undefined {
  const coder = router.primarySelection('Coder');
  const debuggerSelection = router.primarySelection('Debugger');
  if (!coder || !debuggerSelection) return undefined;
  if (coder.model.trim().toLowerCase() !== debuggerSelection.model.trim().toLowerCase()) return undefined;
  return { coder, debugger: debuggerSelection };
}

/** 启动期建议，不阻断执行；同时写入带 messageId 的审计事件。 */
export async function reportRoleModelAdvice(
  router: LLMRouter,
  audit?: AuditLogger,
  reporter: (message: string) => void | Promise<void> = (message) => {
    console.log(chalk.yellow('!'), message);
  },
): Promise<RoleModelAdvice | undefined> {
  const advice = findSharedCoderDebuggerModel(router);
  if (!advice) return undefined;
  const text = t().llm.coderDebuggerSameModel(
    advice.coder.model,
    advice.coder.provider,
    advice.debugger.provider,
  );
  await reporter(text);
  await audit?.event('note', text, {
    messageId: 'llm.coder_debugger_same_model',
    coder: advice.coder,
    debugger: advice.debugger,
  });
  return advice;
}
