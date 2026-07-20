MODULE TestExtension(SYSMODULE)
    !========================================================================
    ! TestExtension.mod - minimal test module for the RAPID Live extension.
    ! Compatible with both IRC5 (RobotWare 6) and OmniCore (RobotWare 7).
    ! No I/O signals, no dnum, no complex literals - just core RAPID.
    !========================================================================

    VAR num     counter := 0;
    VAR num     pi      := 3.14159;
    VAR bool    isReady := TRUE;
    VAR string  greeting := "Hello from RAPID Live";

    PERS num    persistentCounter := 0;
    PERS string lastTestResult    := "(none yet)";

    CONST num   maxIterations := 1000;
    CONST string moduleVersion := "1.2";

    ! Entry point. Required for PP-to-Main to work after loading this module
    ! standalone (i.e. when no other ProgMod with a `main` is loaded).
    !
    ! NOTE on coexistence with OmniCore's default Module1:
    ! Both modules cannot define `main` simultaneously - RWS 2.0 rejects PP-to-Main
    ! with SYS_CTRL_E_RAPID_SEMANTIC_ERROR (-1073442802) when there's a duplicate
    ! main. If you have Module1 loaded, either unload it first ("Modules" panel
    ! → right-click Module1 → Unload), or use the `testCounterLoop`-style routines
    ! below via the "Set PP to routine" command instead of PP-to-Main.
    PROC main()
        TPWrite "TestExtension v" + moduleVersion;
        counter := counter + 1;
        persistentCounter := persistentCounter + 1;
        lastTestResult := "main ran";
        TPWrite "counter = " + ValToStr(counter);
        Stop;
    ENDPROC

    PROC testCounterLoop()
        VAR num i;
        TPErase;
        FOR i FROM 1 TO 100 DO
            counter := counter + 1;
            persistentCounter := persistentCounter + 1;
            WaitTime 0.1;
        ENDFOR
        Stop;
    ENDPROC

    PROC testTPWrite()
        VAR num i;
        TPErase;
        FOR i FROM 1 TO 5 DO
            TPWrite "Message " + ValToStr(i);
            WaitTime 0.5;
        ENDFOR
        Stop;
    ENDPROC

    PROC testTPReadNum()
        VAR num userValue;
        TPErase;
        TPReadNum userValue, "Enter any number:";
        counter := userValue;
        TPWrite "Got: " + ValToStr(userValue);
        Stop;
    ENDPROC

    PROC testError()
        VAR num x := 10;
        VAR num y := 0;
        VAR num result;
        TPErase;
        result := x / y;
        TPWrite "result: " + ValToStr(result);
    ERROR
        TPWrite "caught ERRNO=" + ValToStr(ERRNO);
        lastTestResult := "Caught ERRNO=" + ValToStr(ERRNO);
        TRYNEXT;
    ENDPROC

    PROC testWaitTime()
        TPErase;
        TPWrite "sleeping 30s";
        WaitTime 30;
        TPWrite "done";
        Stop;
    ENDPROC

    PROC resetCounters()
        counter := 0;
        persistentCounter := 0;
        lastTestResult := "(reset)";
        TPWrite "reset";
        Stop;
    ENDPROC

ENDMODULE
