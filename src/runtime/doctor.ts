import {
  runDoctor,
  type CheckLevel,
  type DoctorOptions,
  type DoctorReport,
} from '../core/doctor.js';

export interface RuntimeDoctorOptions extends DoctorOptions {
  /** Exit non-zero on warnings as well as failures. */
  strict?: boolean;
}

export interface RuntimeDoctorResult {
  report: DoctorReport;
  exitCode: number;
}

export async function runDoctorCommand(opts: RuntimeDoctorOptions = {}): Promise<RuntimeDoctorResult> {
  const report = await runDoctor(opts);
  const exitCode = report.fails > 0 || (opts.strict && report.warns > 0) ? 1 : 0;
  return { report, exitCode };
}

export { runDoctor, type CheckLevel, type DoctorOptions, type DoctorReport };
