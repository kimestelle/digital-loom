import { ComponentPreview } from "@/lib/ui/workbench/preview";
import { isComponentId } from "@/lib/ui/workbench/catalog";
import "../workbench.css";

export default async function PreviewPage({ searchParams }: {
  searchParams: Promise<{ component?: string }>;
}) {
  const { component } = await searchParams;
  return <ComponentPreview id={isComponentId(component) ? component : "logo"} />;
}
