import { diagnoseRepository, formatDoctorReport, type DoctorReport } from "../core/doctor.js";

export async function doctorCommand(cwd: string, configPath: string, json = false, verbose = false): Promise<DoctorReport> {
  const report = await diagnoseRepository(cwd, configPath, verbose);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorReport(report)}\n`);
  return report;
}
