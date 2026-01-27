<!-- Start SDK Example Usage [usage] -->
```typescript
import { Detent } from "@detent/sdk";

const detent = new Detent();

async function run() {
  const result = await detent.diagnostics.postV1Diagnostics({
    content: "src/app.ts:10:5 - error TS2304: Cannot find name 'foo'",
  });

  console.log(result);
}

run();

```
<!-- End SDK Example Usage [usage] -->