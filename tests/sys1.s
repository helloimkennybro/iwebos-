.include "common.inc"
.globl _start
.arm
_start:
  ldr sp, =stk
  ldr r0, =vectors
  mcr p15, 0, r0, c12, c0, 0       @ VBAR
  @ ---- undefined instruction
  mov r8, #0
  .word 0xe7f000f0
  EXPECT r8, 1, 1
  @ ---- SVC and its immediate
  svc #5
  EXPECT r9, 5, 2
  @ ---- register banking
  mov r8, #0x88
  msr cpsr_c, #0xD1
  mov r8, #0xF8
  mov r13, #0xF13
  msr cpsr_c, #0xD3
  EXPECT r8, 0x88, 3
  msr cpsr_c, #0xD1
  EXPECT r8, 0xF8, 4
  EXPECT r13, 0xF13, 5
  msr cpsr_c, #0xD3
  EXPECT r13, stk, 6
  msr cpsr_c, #0xDF
  mov r13, #0x5050
  msr cpsr_c, #0xD3
  ldr r0, =buf
  stmia r0, {sp}^
  ldr r1, [r0]
  EXPECT r1, 0x5050, 7
  mrs r1, cpsr
  and r1, r1, #0x1f
  EXPECT r1, 0x13, 8
  @ ---- build page tables
  ldr r0, =ttb
  ldr r1, =(0x40000000 | 0xC02)
  mov r2, #16
  ldr r3, =ttb + 0x1000
1: str r1, [r3], #4
  add r1, r1, #0x100000
  subs r2, r2, #1
  bne 1b
  ldr r1, =(0x10000000 | 0xC02)
  str r1, [r0, #0x400]
  ldr r1, =(0x40100000 | 0xC02)
  add r3, r0, #0x2000
  str r1, [r3]              @ VA 0x80000000 -> PA 0x40100000 RW
  ldr r1, =(0x40200000 | 0x402)
  add r3, r0, #0x2400
  str r1, [r3]              @ VA 0x90000000 -> PA 0x40200000 priv only
  ldr r1, =(l2tab + 1)
  add r3, r0, #0x2800
  str r1, [r3]              @ VA 0xA0000000 -> coarse table
  ldr r2, =l2tab
  ldr r1, =(0x40300000 | 0x32)
  str r1, [r2]
  ldr r1, =(0x40400000 | 0x412)
  add r3, r0, #0x2C00
  str r1, [r3]              @ VA 0xB0000000 section, XN, RW
  mcr p15, 0, r0, c2, c0, 0          @ TTBR0
  mov r1, #1
  mcr p15, 0, r1, c3, c0, 0          @ DACR: domain0 client
  mrc p15, 0, r1, c1, c0, 0
  orr r1, r1, #1
  mcr p15, 0, r1, c1, c0, 0          @ MMU on
  @ ---- alias mapping
  ldr r1, =0x80000000
  ldr r2, =0xC0FFEE00
  str r2, [r1]
  ldr r3, =0x40100000
  ldr r4, [r3]
  EXPECT r4, 0xC0FFEE00, 9
  @ ---- translation fault (read and write)
  mov r6, #0
  ldr r1, =0x00200000
  ldr r0, [r1]
  EXPECT r6, 5, 10
  EXPECT r7, 0x00200000, 11
  mov r6, #0
  str r0, [r1, #8]
  EXPECT r6, 0x805, 12
  EXPECT r7, 0x00200008, 13
  @ ---- coarse table small page
  ldr r1, =0xA0000000
  str r2, [r1, #0x10]
  ldr r3, =0x40300000
  ldr r4, [r3, #0x10]
  EXPECT r4, 0xC0FFEE00, 14
  @ ---- privilege check: privileged access to priv-only section is fine
  ldr r1, =0x90000000
  ldr r0, [r1]
  @ ---- user mode access to priv-only section -> permission fault
  mov r6, #0
  msr cpsr_c, #0x10
  ldr r1, =0x90000000
  ldr r0, [r1]
  svc #0x99
  EXPECT r6, 0xD, 15
  EXPECT r7, 0x90000000, 16
  mrs r1, cpsr
  and r1, r1, #0x1f
  EXPECT r1, 0x13, 17
  @ ---- remap + TLB flush
  ldr r1, =0x40200000
  ldr r2, =0x13572468
  str r2, [r1]
  ldr r0, =ttb
  ldr r1, =(0x40200000 | 0xC02)
  add r3, r0, #0x2000
  str r1, [r3]
  mov r1, #0
  mcr p15, 0, r1, c8, c7, 0
  ldr r1, =0x80000000
  ldr r3, [r1]
  EXPECT r3, 0x13572468, 18
  @ ---- execute-never prefetch abort
  mov r5, #0
  adr r4, cont
  ldr r1, =0xB0000000
  bx r1
cont:
  msr cpsr_c, #0xD3
  EXPECT r5, 0xD, 19
  EXPECT r6, 0xB0000000, 20
  @ ---- address translation op (ATS1CPR)
  ldr r1, =0x80000000
  mcr p15, 0, r1, c7, c8, 0
  mrc p15, 0, r2, c7, c4, 0
  EXPECT r2, 0x40200000, 21
  @ ---- IRQ delivery
  mov r10, #0
  msr cpsr_c, #0x13
1: cmp r10, #1
  bne 1b
  b pass
.ltorg
.balign 32
vectors:
  b .
  b h_und
  b h_svc
  b h_pabt
  b h_dabt
  b .
  b h_irq
  b .
h_und:
  mov r8, #1
  movs pc, lr
h_svc:
  ldr r0, [lr, #-4]
  bic r9, r0, #0xff000000
  cmp r9, #0x99
  bne 1f
  mrs r1, spsr
  bic r1, r1, #0x1f
  orr r1, r1, #0x13
  msr spsr_cxsf, r1
1: movs pc, lr
h_dabt:
  mrc p15, 0, r6, c5, c0, 0
  mrc p15, 0, r7, c6, c0, 0
  subs pc, lr, #4
h_pabt:
  mrc p15, 0, r5, c5, c0, 1
  mrc p15, 0, r6, c6, c0, 2
  mov pc, r4
h_irq:
  ldr r0, =0x10001000
  str r0, [r0]
  add r10, r10, #1
  subs pc, lr, #4
.ltorg
PASSFAIL
.ltorg
.balign 16384
ttb: .space 16384
.balign 1024
l2tab: .space 1024
.balign 16
buf: .space 64
.space 512
stk:
