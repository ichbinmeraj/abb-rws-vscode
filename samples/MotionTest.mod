MODULE MotionTest
    !========================================================================
    ! MotionTest.mod — Motion demo for the RAPID Live extension.
    !
    ! Demonstrates that the extension can move the robot. Each procedure runs
    ! a different motion pattern that's visible in RobotStudio's 3D view.
    !
    ! Workflow in the extension:
    !   1. Upload Module → pick this file
    !   2. Motors On (Status panel)
    !   3. PP to Main → Start RAPID  (runs main, which sweeps a few poses)
    !   OR set PP to a specific routine via the right-click menu in the
    !   Modules panel — testSquare, testWave, testPickPlace.
    !
    ! Compatible with both IRC5 (RobotWare 6) and OmniCore (RobotWare 7).
    ! Uses tool0 + wobj0 so you don't need to configure tooling.
    !========================================================================

    VAR num    counter        := 0;
    VAR num    cycleCount     := 0;
    PERS num   persistentRuns := 0;

    CONST string moduleVersion := "1.0";

    ! ─── Targets ────────────────────────────────────────────────────────────
    ! Reachable poses for IRB120 / IRB1200 — small workspace.
    ! Adjust if your robot has a different reach.

    CONST robtarget pHome   := [[400,   0, 600], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pCorner1 := [[400, 100, 500], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pCorner2 := [[400, 100, 700], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pCorner3 := [[400,-100, 700], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pCorner4 := [[400,-100, 500], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];

    ! Pick/place stations
    CONST robtarget pPick   := [[450, 200, 400], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pPlace  := [[450,-200, 400], [0, 0, 1, 0], [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];

    ! ─── main: continuous demo loop — robot keeps moving until you click Stop ──
    !
    ! Each iteration takes ~10 s so motion is clearly visible in the 3D view.
    ! The previous version ran ONCE then stopped (and at fine/v500 it was over
    ! in 3 s — easy to miss). This version loops with deliberate pacing.
    !
    ! Want a single-pass run? Right-click the module → Set PP to Routine →
    ! pick `mainSinglePass`, then Start.
    PROC main()
        TPErase;
        TPWrite "MotionTest v" + moduleVersion + " — continuous demo. Click Stop to exit.";
        WHILE TRUE DO
            cycleCount := cycleCount + 1;
            persistentRuns := persistentRuns + 1;
            TPWrite "── cycle " + ValToStr(cycleCount) + " ──";

            ! Slow square (v100 = ~3 s per side; obvious in the 3D view)
            MoveJ pHome,    v100, fine, tool0\WObj:=wobj0;
            MoveJ pCorner1, v100, fine, tool0\WObj:=wobj0;
            MoveL pCorner2, v100, fine, tool0\WObj:=wobj0;
            MoveL pCorner3, v100, fine, tool0\WObj:=wobj0;
            MoveL pCorner4, v100, fine, tool0\WObj:=wobj0;
            MoveL pCorner1, v100, fine, tool0\WObj:=wobj0;
            MoveJ pHome,    v200, fine, tool0\WObj:=wobj0;
            counter := counter + 7;

            WaitTime 0.5;  ! brief pause between cycles
        ENDWHILE
    ENDPROC

    ! Single-pass version of the square — runs once, then Stop. Use this
    ! when you want a quick verification rather than an endless demo.
    PROC mainSinglePass()
        TPErase;
        TPWrite "MotionTest single-pass starting…";
        cycleCount := cycleCount + 1;
        persistentRuns := persistentRuns + 1;
        MoveJ pHome,    v100, fine, tool0\WObj:=wobj0;
        MoveJ pCorner1, v100, fine, tool0\WObj:=wobj0;
        MoveL pCorner2, v100, fine, tool0\WObj:=wobj0;
        MoveL pCorner3, v100, fine, tool0\WObj:=wobj0;
        MoveL pCorner4, v100, fine, tool0\WObj:=wobj0;
        MoveL pCorner1, v100, fine, tool0\WObj:=wobj0;
        MoveJ pHome,    v200, fine, tool0\WObj:=wobj0;
        counter := counter + 7;
        TPWrite "single-pass done — total runs " + ValToStr(persistentRuns);
        Stop;
    ENDPROC

    ! ─── A more interesting traj: zig-zag wave around the square ────────────
    PROC testWave()
        VAR num  i;
        VAR num  amplitude := 50;
        VAR robtarget p;
        TPErase;
        TPWrite "testWave: zig-zag";

        MoveJ pHome, v500, fine, tool0\WObj:=wobj0;
        FOR i FROM 0 TO 8 DO
            p := pHome;
            p.trans.x := pHome.trans.x;
            p.trans.y := -100 + i * 25;
            p.trans.z := pHome.trans.z + (i MOD 2) * amplitude;
            MoveL p, v300, fine, tool0\WObj:=wobj0;
            counter := counter + 1;
        ENDFOR
        MoveJ pHome, v500, fine, tool0\WObj:=wobj0;
        Stop;
    ENDPROC

    ! ─── Pick & place pattern with simulated I/O ────────────────────────────
    PROC testPickPlace()
        VAR num   reps;
        VAR robtarget pAbove;

        TPErase;
        TPWrite "testPickPlace: 3 cycles";

        FOR reps FROM 1 TO 3 DO
            ! Approach pick
            pAbove := pPick;
            pAbove.trans.z := pAbove.trans.z + 100;
            MoveJ pAbove, v500, z10, tool0\WObj:=wobj0;
            MoveL pPick,  v200, fine, tool0\WObj:=wobj0;
            ! "grip" — would set a DO here in a real cell
            WaitTime 0.3;
            MoveL pAbove, v200, z10, tool0\WObj:=wobj0;

            ! Approach place
            pAbove := pPlace;
            pAbove.trans.z := pAbove.trans.z + 100;
            MoveJ pAbove, v500, z10, tool0\WObj:=wobj0;
            MoveL pPlace, v200, fine, tool0\WObj:=wobj0;
            ! "release"
            WaitTime 0.3;
            MoveL pAbove, v200, z10, tool0\WObj:=wobj0;
            counter := counter + 1;
        ENDFOR

        MoveJ pHome, v500, fine, tool0\WObj:=wobj0;
        Stop;
    ENDPROC

    ! ─── Pure joint motion: each axis to extremes one at a time ─────────────
    PROC testJoints()
        VAR jointtarget jt;
        VAR num         a;

        TPErase;
        TPWrite "testJoints: each axis through its mid-range";

        ! Start from a safe joint pose
        jt := [[0, 0, 0, 0, 30, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
        MoveAbsJ jt, v500, fine, tool0\WObj:=wobj0;

        ! Sweep J1 ±45°
        FOR a FROM -45 TO 45 STEP 30 DO
            jt.robax.rax_1 := a;
            MoveAbsJ jt, v500, fine, tool0\WObj:=wobj0;
            counter := counter + 1;
        ENDFOR
        ! Reset J1, sweep J5
        jt.robax.rax_1 := 0;
        FOR a FROM 0 TO 90 STEP 30 DO
            jt.robax.rax_5 := a;
            MoveAbsJ jt, v500, fine, tool0\WObj:=wobj0;
            counter := counter + 1;
        ENDFOR
        ! Home
        jt.robax := [0, 0, 0, 0, 30, 0];
        MoveAbsJ jt, v500, fine, tool0\WObj:=wobj0;
        Stop;
    ENDPROC

    ! ─── Reset counters ─────────────────────────────────────────────────────
    PROC resetCounters()
        counter := 0;
        cycleCount := 0;
        TPWrite "MotionTest counters reset";
        Stop;
    ENDPROC

ENDMODULE
