# iWebOS

An iPad 1 (iPad1,1) running iOS 3.2 (7B367) in the browser, on an ARMv7 emulator written from scratch in JavaScript and WebAssembly.

Open `dist/iwebos.html`, pick your own iOS 3.2 IPSW, and press **Boot iPad**. The firmware is decrypted and loaded in the browser; nothing is uploaded and no Apple files are included in this repository.

## What works
- ARMv7 CPU (ARM + Thumb-2, VFP, part of NEON), MMU, exceptions
- Decoded-instruction cache and a block JIT that compiles hot code to WebAssembly
- Guest RAM in a WebAssembly memory pool with LZ4 compression of cold pages
- Interrupt controller, timer, UARTs, I²C controller, D1815 power chip
- Apple logo boot screen (decoded from the IPSW) and verbose text console
- The kernel boots, matches its drivers and mounts the restore ramdisk as root

## Next
- DMA controller and AES engine (needed before userland starts)
- Restore ramdisk userland, SpringBoard, touch

## Layout
- `src/` emulator: CPU, decoder, JIT, memory, devices, firmware loader
- `ui/index.html` page template, `tools/bundle.js` builds `dist/iwebos.html`
- `tests/` CPU test programs (`node tests/all.js`)
- `tools/` debugging and benchmark scripts (expect an IPSW at `fw/ipad.ipsw` or `IPSW=path`)
