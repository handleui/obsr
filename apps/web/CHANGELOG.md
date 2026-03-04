# @detent/web

## 1.0.0

### Major Changes

- 565831f: First stable web major after navigator removal.
  Consolidates the product web surface so auth and docs entrypoints now live in apps/web instead of a separate navigator app.

## 0.2.2

### Patch Changes

- 1e7f542: Replace Google Fonts (Geist) with local PP Neue Montreal font.
  Adds tighter letter-spacing and updates web app metadata to proper branding.

## 0.2.1

### Patch Changes

- 6cde710: Remove unused blob API route (handled by vercel.json rewrite)

## 0.2.0

### Minor Changes

- a5bac3a: Initial release of the Detent web application

  ### Features

  - **CLI Installer Script**: Universal shell script that auto-detects OS and architecture for seamless installation
  - **Binary Distribution API**: Next.js API routes for serving pre-built CLI binaries
  - **Vercel Blob Storage Integration**: Reliable binary hosting with CDN distribution

  ### Technical Details

  - Built with Next.js 16 and React 19
  - React Compiler integration for automatic optimizations
  - Tailwind CSS v4 for styling
  - TypeScript throughout with strict type checking
