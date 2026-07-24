---
"@agent-native/core": patch
---

Keep the chat composer and stop-response control available when realtime voice mode starts. The microphone remains visible as an animated stop control until voice mode ends, including in browsers without dictation support. Dictation transcripts now land in the composer only after stopping, with no live word insertion while speaking.
