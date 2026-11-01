import { writeFileSync } from "node:fs";
import { projectionFixture, trajectoryFixture } from "../lib/sim/fixtures";

writeFileSync("shared/fixtures/trajectory.json", JSON.stringify(trajectoryFixture()) + "\n");
writeFileSync("shared/fixtures/projection.json", JSON.stringify(projectionFixture(), null, 2) + "\n");
console.log("wrote shared/fixtures/trajectory.json and projection.json");
