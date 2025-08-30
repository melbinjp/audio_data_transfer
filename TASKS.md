# Prioritized Follow-up Tasks

This document outlines the next steps for this project, based on the "Minimal Viable Product (MVP) Roadmap" section of the [TECHNICAL_PLAN.md](TECHNICAL_PLAN.md).

These tasks are designed to be tackled sequentially to build a working prototype.

| Priority | Task                                                                                             | Suggested Owner | Effort (from plan) |
| :------- | :----------------------------------------------------------------------------------------------- | :-------------- | :----------------- |
| 1 (High) | **Build a minimal prototype to transfer a short text string.**                                     | Frontend Dev    | Tiny               |
|          | - Implement simple FSK (Frequency-shift keying) modulation.                                      |                 |                    |
|          | - Use the Web Audio API to send and receive the tones.                                           |                 |                    |
|          | - Verify that a simple string can be sent and decoded between two browser tabs.                  |                 |                    |
| 2 (Med)  | **Integrate a more robust modem library.**                                                       | Frontend Dev    | Small              |
|          | - Replace the simple FSK with a library like `quiet-js`.                                         |                 |                    |
|          | - Implement file chunking and add a CRC check for basic error detection.                         |                 |                    |
| 3 (Med)  | **Develop the basic user interface.**                                                            | Frontend Dev    | Small              |
|          | - Create UI components for picking a file to send.                                               |                 |                    |
|          | - Add a button to download the received file.                                                    |                 |                    |
|          | - Display basic progress and throughput (bytes/sec).                                             |                 |                    |
| 4 (Low)  | **Set up a testing harness.**                                                                    | QA/Dev          | Medium             |
|          | - Create a suite of recorded WAV files with different noise levels.                              |                 |                    |
|          | - Build a script to run the decoding logic against the test files to ensure deterministic results. |                 |                    |
