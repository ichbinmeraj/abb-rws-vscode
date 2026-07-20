MODULE IOTest
    !========================================================================
    ! IOTest.mod - I/O signal demo for the RAPID Live extension.
    !
    ! Pulses digital outputs in patterns. The extension's I/O panel updates
    ! live as values change, so you can see signal toggles in real time.
    !
    ! NOTE: signal names below match OmniCore's IntegratedIONetwork defaults
    ! (IIO_do0…IIO_do7). On IRC5 you may have DRV1TESTE2 etc. - adjust the
    ! signal names if your config differs.
    !========================================================================

    PROC main()
        TPErase;
        TPWrite "IOTest: pulse pattern starting";
        runPulse;
        TPWrite "IOTest: chase pattern";
        runChase;
        TPWrite "IOTest: done";
        Stop;
    ENDPROC

    ! ─── Pulse all DOs once each ────────────────────────────────────────────
    PROC runPulse()
        SetDO IIO_do0, 1; WaitTime 0.3; SetDO IIO_do0, 0;
        SetDO IIO_do1, 1; WaitTime 0.3; SetDO IIO_do1, 0;
        SetDO IIO_do2, 1; WaitTime 0.3; SetDO IIO_do2, 0;
        SetDO IIO_do3, 1; WaitTime 0.3; SetDO IIO_do3, 0;
    ENDPROC

    ! ─── Chase: like a Knight Rider scanner ─────────────────────────────────
    PROC runChase()
        VAR num cycle;
        FOR cycle FROM 1 TO 3 DO
            ! forward
            SetDO IIO_do0, 1; WaitTime 0.15; SetDO IIO_do0, 0;
            SetDO IIO_do1, 1; WaitTime 0.15; SetDO IIO_do1, 0;
            SetDO IIO_do2, 1; WaitTime 0.15; SetDO IIO_do2, 0;
            SetDO IIO_do3, 1; WaitTime 0.15; SetDO IIO_do3, 0;
            ! back
            SetDO IIO_do3, 1; WaitTime 0.15; SetDO IIO_do3, 0;
            SetDO IIO_do2, 1; WaitTime 0.15; SetDO IIO_do2, 0;
            SetDO IIO_do1, 1; WaitTime 0.15; SetDO IIO_do1, 0;
            SetDO IIO_do0, 1; WaitTime 0.15; SetDO IIO_do0, 0;
        ENDFOR
    ENDPROC

ENDMODULE
