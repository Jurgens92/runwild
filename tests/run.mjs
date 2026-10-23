import { scenarios } from './scenarios.js';

let failed = 0;
for (const sc of scenarios) {
  try {
    await sc.run();
    console.log('PASS  ' + sc.name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + sc.name + '\n      ' + e.message);
  }
}
console.log(`\n${scenarios.length - failed}/${scenarios.length} scenarios passed`);
process.exit(failed ? 1 : 0);
