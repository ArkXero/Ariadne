import { diagnoseRepository, formatDoctorReport } from "../core/doctor.js";

export async function doctorCommand(cwd: string, configPath: string): Promise<void> {
  const report = await diagnoseRepository(cwd, configPath);
  console.log(formatDoctorReport(report));

  if (!report.passed) {
    process.exitCode = 1;
  }
}
