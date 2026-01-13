// Test file to trigger Biome linting errors for local webhook parsing
// DELETE THIS FILE after testing

// Error: Use === instead of ==
const a = 1;
if (a == "1") {
  console.log("loose equality");
}

// Error: Unexpected var, use let or const
var badVariable = "should use const";

// Error: Missing semicolon (if configured)
const noSemi = "test";

// Error: Unused variable
const unusedVar = "never used";

// Error: Debugger statement
debugger;

export {};
