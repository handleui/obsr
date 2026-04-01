import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

// Type assertion needed due to React 19 / MDX type compatibility
const baseComponents = {
  ...defaultMdxComponents,
  Tab,
  Tabs,
} as MDXComponents;

export const getMDXComponents = (components?: MDXComponents): MDXComponents =>
  components ? { ...baseComponents, ...components } : baseComponents;

export const useMDXComponents = getMDXComponents;
