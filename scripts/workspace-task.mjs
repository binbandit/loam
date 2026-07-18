const [task, packageName] = process.argv.slice(2);
const allowedTasks = new Set(["dev", "build", "test"]);

if (!allowedTasks.has(task) || !packageName) {
  throw new Error("Usage: workspace-task.mjs <task> <package-name>");
}

console.log(`[${packageName}] ${task}: bootstrap placeholder`);
