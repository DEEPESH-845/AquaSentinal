import { expect, test } from "./lab";

test.describe("AI perception", () => {
  test("a manual capture renders a 640x480 frame, goes through the pipeline and shows labelled results", async ({ lab, page }) => {
    await lab.openOnline();
    await lab.scene(3);
    const card = lab.card();
    await expect(card.getByText(/No frames yet/)).toBeVisible();
    await card.getByRole("button", { name: /^capture$/i }).click();
    await lab.waitMission((s) => s.captures.length === 1 && s.captures[0].status === "DONE", undefined, 60_000);
    const img = card.getByRole("img", { name: /Inspection frame/ });
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth, el.naturalHeight])).toEqual([640, 480]);

    const r = await lab.mission((s) => s.captures[0].result!);
    expect(r.quality?.source).toBe("IMAGE_DERIVED_ESTIMATE");
    expect(r.reasoning?.provider).toBe("UNAVAILABLE");
    expect(r.segmentations[0].provider).toBe("OFFLINE_FIXTURE");
    // offline masks are the twin's geometry and must be labelled that way
    await expect(card.getByText("TWIN GEOMETRY, NOT A MODEL")).toBeVisible();
    await expect(card.getByText("IMAGE-DERIVED ESTIMATE")).toBeVisible();
    await expect(card.getByText(/Observations \(\d+\)/)).toBeVisible();
    expect(r.observations.every((o) => o.source === "SIM_DETECTOR")).toBe(true);

    // the simulator's boxes are a separate, opt-in layer
    await expect(card.locator("svg text", { hasText: /^SIM / })).toHaveCount(0);
    await card.getByRole("button", { name: /sim detector boxes/i }).click();
    const n = await lab.mission((s) => s.captures[0].request.detections.length);
    await expect(card.locator("svg text", { hasText: /^SIM / })).toHaveCount(n);

    // a second capture adds a selectable entry
    await card.getByRole("button", { name: /^capture$/i }).click();
    await lab.waitMission((s) => s.captures.length === 2 && s.captures[1].status === "DONE", undefined, 60_000);
    await expect(card.getByRole("option")).toHaveCount(2);
    void page;
  });

  test("scenario G: the injected segmentation failure is shown as a failure", async ({ lab }) => {
    await lab.openOnline();
    await lab.scene(6);
    await lab.button(/^G Segmentation failure$/).click();
    await lab.scene(3);
    await lab.card().getByRole("button", { name: /^capture$/i }).click();
    await lab.waitMission((s) => s.captures.length === 1 && s.captures[0].status === "DONE", undefined, 60_000);
    expect(await lab.mission((s) => s.captures[0].result!.segmentations[0].status)).toBe("FAILED");
    await expect(lab.card().getByText(/injected by scenario G/)).toBeVisible();
  });
});
