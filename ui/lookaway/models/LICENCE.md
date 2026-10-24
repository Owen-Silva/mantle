# Look-away face model

| File | What | Source | Licence |
| --- | --- | --- | --- |
| `blaze_face_short_range.tflite` (229,746 bytes, SHA-256 `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f`) | MediaPipe Face Detector, BlazeFace short range, float16: finds faces within about 2 m and six points on each (eyes, nose tip, mouth, ears) | https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite (downloaded 2026-10-23; model card: https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector) | Apache License 2.0, Copyright Google LLC |

The runtime that runs it is the npm package `@mediapipe/tasks-vision` (Apache License 2.0), loaded from
`node_modules` by `ui/lookaway/index.html`. Apache 2.0 is compatible with Mantle's GPL-3.0.

Nothing is downloaded at run time: the page's Content-Security-Policy allows no network, and its
session cancels every web request.
