.include "common.inc"
.globl _start
.arm
_start:
  ldr sp, =stk
  @ --- data processing and flags
  mov r0, #5
  add r1, r0, r0, lsl #2
  EXPECT r1, 25, 1
  ldr r0, =0x7fffffff
  adds r1, r0, #1
  EXPFL 9, 3
  EXPECT r1, 0x80000000, 2
  mvn r0, #0
  adds r1, r0, #1
  EXPFL 6, 4
  mov r0, #5
  cmp r0, #5
  EXPFL 6, 5
  cmp r0, #6
  EXPFL 8, 6
  ldr r0, =0x80000000
  cmp r0, #1
  EXPFL 3, 7
  mov r0, #1
  cmp r0, #0
  adc r1, r0, #10
  EXPECT r1, 12, 8
  cmp r0, #0
  sbc r1, r0, #1
  EXPECT r1, 0, 9
  cmp r0, #2
  sbc r2, r0, #1
  EXPECT r2, 0xffffffff, 10
  @ --- shifts and carry out
  ldr r0, =0x80000001
  movs r1, r0, lsr #1
  EXPFL 2, 12
  EXPECT r1, 0x40000000, 11
  movs r1, r0, asr #32
  EXPFL 10, 14
  EXPECT r1, 0xffffffff, 13
  movs r1, r0, lsr #32
  EXPFL 6, 15
  mov r4, #32
  movs r1, r0, lsl r4
  EXPFL 6, 16
  mov r4, #33
  movs r1, r0, lsl r4
  EXPFL 4, 17
  movs r1, r0, ror #4
  EXPFL 0, 19
  EXPECT r1, 0x18000000, 18
  cmp r0, r0
  mov r2, r0, rrx
  EXPECT r2, 0xC0000000, 20
  movs r2, r0, rrx
  EXPFL 10, 21
  movs r0, #0xff000000
  EXPFL 10, 23
  EXPECT r0, 0xff000000, 22
  @ --- multiplies
  mov r0, #7
  mov r1, #6
  mul r2, r0, r1
  EXPECT r2, 42, 24
  mla r3, r0, r1, r0
  EXPECT r3, 49, 25
  ldr r0, =0xffffffff
  mov r1, r0
  umull r2, r3, r0, r1
  EXPECT r2, 1, 26
  EXPECT r3, 0xfffffffe, 27
  smull r2, r3, r0, r1
  EXPECT r2, 1, 28
  EXPECT r3, 0, 29
  ldr r0, =0x80000000
  smull r2, r3, r0, r0
  EXPECT r2, 0, 30
  EXPECT r3, 0x40000000, 31
  ldr r2, =0xffffffff
  mov r3, #1
  mov r4, #2
  mov r5, #3
  umlal r2, r3, r4, r5
  EXPECT r2, 5, 32
  EXPECT r3, 2, 33
  @ --- load / store
  ldr r6, =buf
  ldr r0, =0x44332211
  str r0, [r6]
  ldrb r1, [r6]
  EXPECT r1, 0x11, 34
  ldrb r1, [r6, #3]
  EXPECT r1, 0x44, 35
  ldrh r1, [r6, #2]
  EXPECT r1, 0x4433, 36
  mov r2, #0x80
  strb r2, [r6, #4]
  ldrsb r1, [r6, #4]
  EXPECT r1, 0xffffff80, 37
  mov r2, #0x8000
  strh r2, [r6, #8]
  ldrsh r1, [r6, #8]
  EXPECT r1, 0xffff8000, 38
  mov r7, r6
  ldr r1, [r7], #4
  EXPECT r1, 0x44332211, 39
  sub r8, r7, r6
  EXPECT r8, 4, 40
  ldr r1, [r7, #-4]!
  sub r8, r7, r6
  EXPECT r8, 0, 41
  mov r3, #1
  ldrb r1, [r6, r3, lsl #1]
  EXPECT r1, 0x33, 42
  mov r2, #0xaa
  strb r2, [r6, #4]
  ldr r1, [r6, #1]
  EXPECT r1, 0xaa443322, 43
  ldr r2, =0x01020304
  ldr r3, =0x05060708
  strd r2, r3, [r6, #16]
  ldr r0, [r6, #16]
  EXPECT r0, 0x01020304, 44
  ldr r0, [r6, #20]
  EXPECT r0, 0x05060708, 45
  ldrd r4, r5, [r6, #16]
  EXPECT r5, 0x05060708, 46
  @ --- ldm / stm / push / pop
  mov r0, #10
  mov r1, #20
  mov r2, #30
  mov r7, r6
  stmia r7!, {r0-r2}
  sub r8, r7, r6
  EXPECT r8, 12, 47
  ldmdb r7!, {r3-r5}
  EXPECT r3, 10, 48
  EXPECT r5, 30, 49
  EXPECT r7, buf, 50
  push {r0-r2, lr}
  mov r0, #0
  mov r1, #0
  pop {r0-r2, lr}
  EXPECT r1, 20, 51
  stmib r6, {r0, r1}
  ldr r3, [r6, #4]
  EXPECT r3, 10, 52
  @ --- branches and interworking
  blx thumbfn
  EXPECT r7, 0x1234, 53
  ldr r0, =thumbfn
  mov r7, #0
  blx r0
  EXPECT r7, 0x1234, 54
  bl armfn
  EXPECT r7, 0x4321, 55
  @ --- bit manipulation
  ldr r0, =0x12345678
  ubfx r1, r0, #4, #8
  EXPECT r1, 0x67, 56
  ldr r0, =0x00F00000
  sbfx r1, r0, #20, #4
  EXPECT r1, 0xffffffff, 57
  mvn r1, #0
  mov r2, #0xA
  bfi r1, r2, #8, #4
  EXPECT r1, 0xfffffaff, 58
  bfc r1, #0, #8
  EXPECT r1, 0xfffffa00, 59
  mov r0, #0x8000
  clz r1, r0
  EXPECT r1, 16, 60
  ldr r0, =0x11223344
  rev r1, r0
  EXPECT r1, 0x44332211, 61
  rev16 r1, r0
  EXPECT r1, 0x22114433, 62
  mov r0, #0xF0
  revsh r1, r0
  EXPECT r1, 0xfffff000, 63
  mov r0, #1
  rbit r1, r0
  EXPECT r1, 0x80000000, 64
  ldr r0, =0x1234ABCD
  uxtb r1, r0
  EXPECT r1, 0xCD, 65
  sxtb r1, r0
  EXPECT r1, 0xffffffcd, 66
  ldr r0, =0x00008001
  sxth r1, r0
  EXPECT r1, 0xffff8001, 67
  ldr r0, =0x00AB0000
  sxtb r1, r0, ror #16
  EXPECT r1, 0xffffffab, 68
  mov r2, #1
  uxtab r1, r2, r0, ror #16
  EXPECT r1, 0xAC, 69
  mov r0, #300
  ssat r1, #8, r0
  EXPECT r1, 127, 70
  usat r1, #8, r0
  EXPECT r1, 255, 71
  mvn r0, #0
  usat r1, #8, r0
  EXPECT r1, 0, 72
  movw r0, #0x5678
  movt r0, #0x1234
  EXPECT r0, 0x12345678, 73
  @ --- conditions
  mov r0, #3
  cmp r0, #3
  moveq r1, #1
  movne r1, #2
  EXPECT r1, 1, 74
  cmp r0, #4
  movlt r1, #5
  movge r1, #6
  EXPECT r1, 5, 75
  ldr r2, =0x80000000
  cmp r0, r2
  movhi r1, #7
  movls r1, #8
  EXPECT r1, 8, 76
  @ --- CP15 identity
  mrc p15, 0, r0, c0, c0, 0
  EXPECT r0, 0x412FC083, 77
  b pass
.ltorg
.thumb
.thumb_func
thumbfn:
  movw r7, #0x1234
  bx lr
.arm
armfn:
  movw r7, #0x4321
  bx lr
PASSFAIL
.ltorg
.align 4
buf: .space 64
.space 256
stk:
