.include "common.inc"
.globl _start
.arm
_start:
  ldr sp, =stk
  ldr r0, =thumbmain
  bx r0
.thumb
.thumb_func
thumbmain:
  @ ---- 16-bit encodings
  movs r0, #5
  adds r1, r0, #3
  EXPECT r1, 8, 1
  subs r2, r1, #9
  EXPFL 8, 2
  movs r0, #0x80
  lsls r0, r0, #24
  EXPECT r0, 0x80000000, 3
  mov r4, #1
  lsls r5, r4, #31
  asrs r5, r5, #31
  EXPECT r5, 0xffffffff, 4
  movs r0, #0xff
  muls r0, r0, r0
  EXPECT r0, 0xfe01, 5
  movs r0, #3
  movs r1, #4
  negs r2, r0
  EXPECT r2, 0xfffffffd, 6
  cmp r0, r1
  EXPFL 8, 7
  ldr r6, =buf
  movs r0, #0x11
  strb r0, [r6, #0]
  movs r0, #0x22
  strb r0, [r6, #1]
  ldrh r1, [r6, #0]
  EXPECT r1, 0x2211, 8
  movs r2, #0
  ldrsb r1, [r6, r2]
  EXPECT r1, 0x11, 9
  movs r0, #0xf0
  strb r0, [r6, #2]
  movs r2, #2
  ldrsb r1, [r6, r2]
  EXPECT r1, 0xfffffff0, 10
  push {r4, r5, lr}
  pop {r4, r5}
  adds r7, r7, #0
  @ ---- IT blocks
  movs r0, #1
  cmp r0, #1
  ite eq
  moveq r1, #10
  movne r1, #20
  EXPECT r1, 10, 11
  cmp r0, #2
  itttt eq
  moveq r1, #1
  moveq r2, #2
  moveq r3, #3
  moveq r4, #4
  EXPECT r1, 10, 12
  cmp r0, #2
  itete ne
  movne r1, #7
  moveq r1, #8
  movne r2, #9
  moveq r2, #11
  EXPECT r1, 7, 13
  EXPECT r2, 9, 14
  @ ---- 32-bit encodings
  movw r0, #0x1234
  movt r0, #0xABCD
  EXPECT r0, 0xABCD1234, 15
  add.w r1, r0, #0x00FF0000
  EXPECT r1, 0xACCC1234, 16
  orr r2, r0, #0xFF00FF00
  EXPECT r2, 0xFFCDFF34, 17
  mov.w r3, #0xA5A5A5A5
  EXPECT r3, 0xA5A5A5A5, 18
  sub.w r4, r0, r3, lsl #4
  EXPECT r4, 0x5172b7e4, 19
  ubfx r1, r0, #4, #12
  EXPECT r1, 0x123, 20
  sbfx r1, r0, #24, #8
  EXPECT r1, 0xffffffab, 21
  mov r1, #0
  bfi r1, r0, #4, #8
  EXPECT r1, 0x340, 22
  clz r1, r0
  EXPECT r1, 0, 23
  rev r1, r0
  EXPECT r1, 0x3412CDAB, 24
  rbit r1, r0
  EXPECT r1, 0x2C48B3D5, 25
  umull r2, r3, r0, r0
  EXPECT r3, 0x734b9a97, 26
  EXPECT r2, 0xa0935a90, 27
  mls r1, r0, r0, r0
  EXPECT r1, 0x0b39b7a4, 28
  @ ---- ldr/str 32-bit forms
  str r0, [r6, #100]
  ldr r1, [r6, #100]
  EXPECT r1, 0xABCD1234, 29
  str r0, [r6, #-4]!
  ldr r1, [r6], #4
  EXPECT r1, 0xABCD1234, 30
  movs r2, #4
  ldr r1, [r6, r2, lsl #2]
  ldrd r2, r3, [r6, #96]
  ldr r1, =0xDEADBEEF
  strd r1, r0, [r6, #8]
  ldr r2, [r6, #8]
  EXPECT r2, 0xDEADBEEF, 31
  @ ---- ldm/stm 32-bit
  movs r1, #1
  movs r2, #2
  movs r3, #3
  stmdb r6!, {r1-r3}
  ldmia r6!, {r7-r9}
  EXPECT r9, 3, 32
  @ ---- branches
  bl thumb2
  EXPECT r7, 0x77, 33
  cbz r7, bad
  movs r7, #0
  cbnz r7, bad
  cbz r7, ok1
bad:
  movw r11, #34
  b fail
ok1:
  @ table branch
  movs r1, #1
  tbb [pc, r1]
tbl: .byte (t0-tbl)/2, (t1-tbl)/2
t0: movw r11, #35
  b fail
t1:
  @ ---- high-register and special forms
  mov r8, sp
  add r8, r8, #0
  mov r0, r8
  cmp r0, sp
  EXPFL 6, 36
  ldr r0, =armfn2
  blx r0
  EXPECT r7, 0x55, 37
  b pass
.ltorg
.thumb_func
thumb2:
  movs r7, #0x77
  bx lr
.arm
armfn2:
  mov r7, #0x55
  bx lr
.thumb
PASSFAIL
.ltorg
.align 4
.space 64
buf: .space 128
.space 256
stk:
