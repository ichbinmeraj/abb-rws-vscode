MODULE ZZ_PROBE
  ! Probe loop for the host harness (npm run test:host, step E2): moves nothing.
  ! Load it into T_ROB1 and put the program pointer at ZZ_PROBE_LOOP before E2.
  PROC ZZ_PROBE_LOOP()
    WHILE TRUE DO
      WaitTime 0.5;
    ENDWHILE
  ENDPROC
ENDMODULE
