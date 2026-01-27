import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export const getMDXComponents = (components?: MDXComponents) =>
  ({
    ...defaultMdxComponents,
    Tab,
    Tabs,
    ...components,
  }) as MDXComponents;
