.syntax unified
.arm
mov r0,#5
add r1,r0,r0,lsl #2
.thumb
adds r2,r1,#3
movw r3,#0x1234
