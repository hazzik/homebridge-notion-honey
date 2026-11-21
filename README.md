# Notion / Honey Smart Home plugin for Homebridge

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

This Homebridge plugin shows Notion sensors in Apple Home. In Australia, Honey Insurance runs the Notion service as the **Honey Smart Home** app. The plugin signs in with the account that you use in that app.

Each task that you set up on a sensor in the app shows up in Apple Home as one of these sensors:

| Task in the app                               | Shows up as        |
| --------------------------------------------- | ------------------ |
| Door, window, sliding door, garage door, safe | Contact sensor     |
| Water leak                                    | Leak sensor        |
| Smoke / CO alarm listening                    | Smoke sensor       |
| Temperature                                   | Temperature sensor |

Apple Home shows a low battery and an offline sensor as warnings on each tile of the sensor. The plugin skips the mould risk task, because Apple Home has no tile for mould risk.

## HomeKit and Matter

The plugin publishes the sensors over each protocol that your Homebridge bridge uses:

- **HomeKit**, which Homebridge turns on by default. Each sensor is one accessory with a tile for each task.
- **Matter**, when the bridge config has a `matter` section. A sensor with one task is one Matter device. A sensor with more than one task is one Matter device with a part for each task. The plugin reports a low battery on the sensor's Matter device and marks an offline sensor as not reachable.

If you pair both the HomeKit bridge and the Matter bridge with Apple Home, each sensor shows up twice.

Over Matter, a sensor that you rename in the app keeps its old name until Homebridge restarts. When you add a task to a sensor or remove one, the plugin removes the sensor's Matter device and adds it again, so Apple Home may show the sensor as a new device.

## How it works

The plugin checks the Notion/Honey service every 60 seconds by default, so a door that opens can take up to a minute to show as open. If several checks in a row fail, the HomeKit tiles show "Not Responding" and the plugin marks every Matter device as not reachable. Both stay that way until a check succeeds again. If the service rejects the password, the plugin waits longer than usual before it tries again, so that the service does not lock your account.

You can set `email`, `password`, `pollSeconds` and `push`. `pollSeconds` is the time between checks in seconds, from 30 to 3600. `push` turns on push updates, which are off by default.

## Push updates

With push updates on, the plugin also checks the service as soon as the service sends an alert to the Honey Smart Home app. To get the alerts, the plugin registers itself with your account as an Android phone with the app. The plugin receives the same alerts as the app, so a change that the app does not alert you about shows up at the next check.

The plugin saves the phone in `homebridge-notion-honey-push.json` in the Homebridge storage folder, so that it stays the same phone after a restart. Homebridge must be able to reach `mtalk.google.com` on TCP port 5228. If the plugin cannot connect there in time, or if Google or the Notion/Honey service rejects the phone, the plugin logs a warning and starts push again later. It waits longer after each failure, up to a limit. The plugin keeps checking the service every `pollSeconds` all the time.

This plugin is not affiliated with Notion, Comcast or Honey Insurance. It uses an unofficial API.

## Licence

Copyright (C) 2026 Alex Zaytsev. Licensed under the GNU Lesser General Public License, version 3 or (at your option) any later version. See `LICENSE`.
