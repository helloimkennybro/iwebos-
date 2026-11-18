#!/bin/sh
# build.sh name  -> name.bin (flat, linked at 0x40000000)
set -e
cd "$(dirname "$0")"
clang --target=armv7-none-eabi -mcpu=cortex-a8 -c $1.s -o $1.o
ld.lld -Ttext=0x40000000 -e _start $1.o -o $1.elf
llvm-objcopy -O binary $1.elf $1.bin
