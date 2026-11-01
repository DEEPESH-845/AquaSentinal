# Roadmap

## Needed before field use

1. Run every Meta integration with a real `MODEL_API_KEY` and record latency, cost and SAM IoU against the twin.
2. Calibrate the image-derived visibility estimate against a physical turbidity sensor (it is already fitted to twin frames).
3. Bring up the gantry with GRBL 1.1 using the checklist in docs/HARDWARE_INTEGRATION.md and verify homing, limits, feed hold and e-stop.
4. Confirm whether GRBL retains position across feed hold plus reset on this machine; if so, drop the re-homing requirement after `stop`.
5. Verify the Pi camera path through `AQUA_CAMERA_DEVICE` and the colour of real underwater frames.
6. Add authentication to the backend before it leaves a local network.

## Next capabilities

- Realtime transcription over `wss://api.meta.ai/v1/asr/realtime` for live captions while holding the button.
- SAM 3.1 video segmentation on a short clip at each waypoint, using its own object ids within a clip.
- Re-observation in the backend executor, matching the twin.
- Operator verification of anomaly candidates (verified, dismissed) stored with the observation.
- PostgreSQL repository behind the same interface; object storage for frames.
- Physical sensor adapters (turbidity, light) feeding the visibility controller, labelled as measured.
- A YOLO baseline trained on tank objects; the COCO model from HydraLoom was not migrated because its classes do not describe them.
