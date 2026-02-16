"use client";

import { lazy, Suspense } from "react";

const BetterStackWebVitals = lazy(() =>
  import("@logtail/next/webVitals").then((m) => ({
    default: m.BetterStackWebVitals,
  }))
);

const WebVitals = () => (
  <Suspense fallback={null}>
    <BetterStackWebVitals />
  </Suspense>
);

export default WebVitals;
