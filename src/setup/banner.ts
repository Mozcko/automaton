import chalk from "chalk";

export function showBanner(): void {
  console.log("");
  console.log(chalk.cyan("  DATA CRAB"));
  console.log(chalk.dim("  v0.2.0 - autonomous trading research runtime."));
  console.log("");
}
