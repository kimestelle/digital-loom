import type { CSSProperties } from "react";
import type { MaterialPackage } from "@/lib/core/materialPackage";
declare function FabricViewer(props: {
  pkg?: MaterialPackage | null;
  fabricId?: "myeongju" | "mosi" | "mumyeong" | "jersey" | "sambe" | "denim";
  knobs?: Record<string, unknown>;
  mode?: "cloth" | "object";
  className?: string;
  style?: CSSProperties;
}): React.JSX.Element;
export default FabricViewer;
