MODULE TestMotion
    !========================================================================
    ! TestMotion.mod - motion test routines. ONLY runs when the controller
    !                  is in MANR with motors on. Otherwise will fail at the
    !                  first MoveJ.
    !
    ! Use this to verify:
    !   - Live joint / Cartesian updates in the Motion panel
    !   - PP / Motion Pointer updates during execution
    !   - Speed-ratio changes affecting actual motion speed
    !========================================================================

    CONST jointtarget jHome := [[0, 0, 0, 0, 30, 0],
                                [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];

    !── Safe motion targets within IRB 1200's reach (520-870mm radius) ──────
    CONST robtarget pA := [[400,  100, 600], [0.7071068, 0, 0.7071068, 0],
                           [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pB := [[400, -100, 600], [0.7071068, 0, 0.7071068, 0],
                           [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];
    CONST robtarget pC := [[400,    0, 700], [0.7071068, 0, 0.7071068, 0],
                           [0, 0, 0, 0], [9E9, 9E9, 9E9, 9E9, 9E9, 9E9]];

    PERS num motionCycles := 0;

    !========================================================================
    ! main() - moves to home, then cycles through 3 points.
    !========================================================================
    PROC main()
        TPErase;
        TPWrite "Motion test - moving to home";
        MoveAbsJ jHome\NoEOffs, v500, fine, tool0;

        WHILE motionCycles < 3 DO
            TPWrite "Cycle " + ValToStr(motionCycles + 1);
            MoveJ pA, v500, z10, tool0\WObj:=wobj0;
            MoveJ pB, v500, z10, tool0\WObj:=wobj0;
            MoveJ pC, v500, z10, tool0\WObj:=wobj0;
            motionCycles := motionCycles + 1;
        ENDWHILE

        TPWrite "Returning home";
        MoveAbsJ jHome\NoEOffs, v500, fine, tool0;
        TPWrite "Motion test complete";
        Stop;
    ENDPROC

    !========================================================================
    ! moveTriangle() - slow triangular path good for watching live position
    !                  updates in the extension's Motion panel.
    !========================================================================
    PROC moveTriangle()
        VAR num i;
        FOR i FROM 1 TO 5 DO
            MoveL pA, v100, fine, tool0\WObj:=wobj0;
            MoveL pB, v100, fine, tool0\WObj:=wobj0;
            MoveL pC, v100, fine, tool0\WObj:=wobj0;
        ENDFOR
        Stop;
    ENDPROC

    !========================================================================
    ! goHome() - quick way to get back to a known pose.
    !========================================================================
    PROC goHome()
        MoveAbsJ jHome\NoEOffs, v1000, fine, tool0;
        Stop;
    ENDPROC

    !========================================================================
    ! resetMotion() - reset counters.
    !========================================================================
    PROC resetMotion()
        motionCycles := 0;
        TPWrite "motionCycles reset to 0";
        Stop;
    ENDPROC

ENDMODULE
