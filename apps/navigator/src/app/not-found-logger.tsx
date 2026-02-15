"use client";

import { Logger } from "@logtail/next";
import { useEffect } from "react";

const NotFoundLogger = () => {
  useEffect(() => {
    const log = new Logger({ source: "not-found.tsx" });
    // Only log origin + pathname to avoid leaking tokens in query params or fragments
    log.warn("Page not found", {
      statusCode: 404,
      path: window.location.pathname,
    });
    log.flush();
  }, []);

  return null;
};

export default NotFoundLogger;
