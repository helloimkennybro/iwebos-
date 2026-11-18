.syntax unified
.macro EXPECT reg, val, id
  ldr r12, =\val
  cmp \reg, r12
  beq 1f
  movw r11, #\id
  b fail
1:
.endm
.macro EXPFL val, id
  mrs r12, apsr
  lsr r12, r12, #28
  cmp r12, #\val
  beq 1f
  movw r11, #\id
  b fail
1:
.endm
.macro PASSFAIL
fail:
  ldr r10, =0x10000000
  str r11, [r10]
  b .
pass:
  mov r11, #0
  ldr r10, =0x10000000
  str r11, [r10]
  b .
.endm
