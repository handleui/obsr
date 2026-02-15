"use client";

import dynamic from "next/dynamic";

const BetterStackWebVitals = dynamic(
  () => import("@logtail/next/webVitals").then((m) => m.BetterStackWebVitals),
  { ssr: false }
);

const WebVitals = () => <BetterStackWebVitals />;

export default WebVitals;
