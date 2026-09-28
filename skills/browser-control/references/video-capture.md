# Capture a tab video

Use these tools for an authorized recording of a specific managed tab. They capture web content only, without audio or browser chrome. FFmpeg must be on the server's `PATH`; without it, recording fails with `fast-chrome-ffmpeg-required`.

1. Call `start_recording({tab_id, fps: 5, max_seconds: 30})`. Supported bounds are 1–15 samples per second and 1–60 seconds. Storage is capped at 100 MiB.
2. Drive the tab through normal observed actions. The recorder samples screenshots in the background and preserves their elapsed timestamps. This is sampled footage, not a guaranteed frame-rate screencast.
3. Call `stop_recording({tab_id})` before you release the tab. It confirms that sampling stopped, clears the extension's recording lease, and encodes the saved frames. The result includes `path`, `seconds`, `frames`, `sample_fps`, and `error`. A non-null error means the capture is incomplete.
4. Read the final saved JPEG in the returned MP4's directory and compare it with the requested final state. The directory also contains `frames.ffconcat` and `capture.json`.
5. Verify the actual MP4 before you report it:

```sh
ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames:format=duration,size -of json recording.mp4
ffmpeg -v error -i recording.mp4 -f null -
```

Compare the video duration with `seconds` within one output frame, allowing for container rounding. Inspect decoded frames before and after the interaction. The encoder uses 30 fps playback while preserving sample timing; it does not speed up the task. The receipt labels this `timestamped-jpeg-sampled-video` and keeps `playback_verified: false` until a separate inspection establishes playback.

Stop recording before credential entry. The recorder stops if it detects populated credential inputs.
