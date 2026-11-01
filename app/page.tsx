import { LabScene } from "@/components/lab/Scene";
import { LabUI } from "@/components/ui/LabUI";

export default function Page() {
  return (
    <main className="relative h-screen w-screen overflow-hidden bg-ground">
      <div className="absolute inset-0">
        <LabScene />
      </div>
      <LabUI />
    </main>
  );
}
