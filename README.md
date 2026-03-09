<p align="center">
  <img src="https://raw.githubusercontent.com/trinityhades/homebridge-bambu-lab/refs/heads/main/homebridge-bambu-logo.png" width="600">
</p>

<span align="center">

[![npm](https://img.shields.io/npm/v/homebridge-bambu-lab.svg)](https://www.npmjs.com/package/homebridge-bambu-lab)
[![npm](https://img.shields.io/npm/dt/homebridge-bambu-lab.svg)](https://www.npmjs.com/package/homebridge-bambu-lab)
[![License](https://img.shields.io/npm/l/homebridge-bambu-lab.svg)](https://github.com/trinityhades/homebridge-bambu-lab/blob/main/LICENSE)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-Donate-yellow.svg)](https://www.buymeacoffee.com/trinityhades)

</span>

# Homebridge Bambu Lab

Homebridge dynamic platform plugin for controlling one or more **Bambu Lab printers** over the local MQTT interface. With support for HKSV to view and record printer camera streams, local motion detection, print state monitoring, and print control.

This project started when I was too lazy to open the Bambu app to turn off the chamber light and wanted to just say `"Hey Siri, turn off the printer light."` And like any good developer, I decided to timesink _15 hours_ into a Homebridge plugin to save myself _15 seconds_.

## Features

- Supports multiple Bambu printers from a single Homebridge platform instance.
- Uses the Homebridge settings UI with a custom multi-printer configuration screen.
- Lets you assign a custom name and selected model to each printer.
- Subscribes to `device/<serial>/report` for printer state updates.
- Exposes HomeKit accessories per printer:
  - **Lightbulb**: chamber light on/off.
  - **Switch**: pause/resume active print.
  - **Optional Fan**: print speed override slider.
  - **Optional Camera**: HomeKit camera accessory for the printer stream.
- Publishes commands to `device/<serial>/request`.
- Handles MQTT disconnects and reconnects automatically per printer.

## Configuration

Use the Homebridge UI to add printers, choose each model, and edit printer names.

Manual `config.json` example:

```json
{
  "platform": "Homebridge Bambu Plugin",
  "name": "Homebridge Bambu Plugin",
  "printers": [
    {
      "name": "Office Printer",
      "model": "X1 Carbon",
      "ipAddress": "192.168.1.50",
      "serialNumber": "01S00C123456789",
      "lanAccessCode": "12345678",
      "mqttPort": 8883,
      "mqttUsername": "bblp",
      "rejectUnauthorized": false,
      "enableSpeedControl": true,
      "enableCamera": true,
      "cameraName": "Office Printer Camera",
      "cameraRtspUrl": "rtsps://bblp:12345678@192.168.1.50:322/streaming/live/1",
      "ffmpegPath": "ffmpeg",
      "cameraVideoCodec": "h264_videotoolbox",
      "enableHksv": false,
      "enableLocalMotionDetection": false,
      "motionSensitivity": 40,
      "hksvPrebufferLengthMs": 4000,
      "hksvFragmentLengthMs": 4000,
      "hksvMaxRecordingSeconds": 20
    },
    {
      "name": "Workshop Printer",
      "model": "P1S",
      "ipAddress": "192.168.1.51",
      "serialNumber": "03W00C987654321",
      "lanAccessCode": "87654321",
      "enableCamera": false
    }
  ]
}
```


## Camera Notes

- If `cameraRtspUrl` is omitted, the plugin auto-builds: `rtsps://<mqttUsername>:<lanAccessCode>@<ipAddress>:322/streaming/live/1`.
- `ffmpeg` must be installed and available in PATH, or configured with `ffmpegPath` per printer.
- `enableHksv` turns on HomeKit Secure Video recording services.
- `enableLocalMotionDetection` runs a local frame-difference detector and updates a Motion Sensor characteristic.
- HKSV uses a rolling fragmented-MP4 prebuffer and starts streams with init segment + buffered fragments before live fragments.
- Recording streams are motion-event bounded with a short post-event tail and graceful `isLast` packet closeout.

## Development

```bash
npm install
npm run build
```

Then link and run Homebridge in debug mode:

```bash
npm link
homebridge -D
```
