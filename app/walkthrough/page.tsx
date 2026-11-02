import type { Metadata } from "next";
import { Walkthrough } from "@/components/walkthrough/Walkthrough";

export const metadata: Metadata = {
  title: "AquaSentinal - Product walkthrough",
  description: "How AquaSentinal turns a spoken instruction into a bounded, adaptive underwater inspection with Meta models, told on the live digital twin.",
};

export default function Page() {
  return <Walkthrough />;
}
