"""GRBL serial driver against a fake controller, motion interlocks, emergency stop and the watchdog."""

import math

import pytest

from app.events import EventBus
from app.hardware.drivers import DriverFault, GantryStatus, SerialGantryDriver, SimulatedGantryDriver, parse_status
from app.hardware.motion import InterlockError, MotionController

from .conftest import FakeGrbl


def test_status_report_parsing():
    s = parse_status("<Run|MPos:123.400,56.700,0.000|FS:500,0|Pn:XY>")
    assert s["state"] == "Run" and s["mpos"] == (12.34, 5.67) and s["pins"] == "XY"
    assert parse_status("<Hold:0|MPos:0.000,0.000,0.000|FS:0,0>")["state"] == "Hold"
    for bad in ("garbage", "<Idle|FS:0,0>", "<Idle|MPos:nan,1,0>"):
        with pytest.raises(DriverFault):
            parse_status(bad)


@pytest.mark.anyio
async def test_grbl_connect_home_move_and_estop():
    fake = FakeGrbl()
    d = SerialGantryDriver(lambda: fake, ack_timeout_s=1)
    await d.connect()
    assert d.connected and not d.homed
    assert b"$X\n" not in fake.written, "never auto-unlock an alarm"
    with pytest.raises(DriverFault, match="not homed"):
        await d.move_to(10, 10, 0.5)
    await d.home()
    assert d.homed and b"$H\n" in fake.written
    await d.move_to(42.5, 20, 0.5)
    assert b"G90 G21 G1 X425.000 Y200.000 F4500\n" in fake.written
    s = await d.get_status()
    assert (s.x, s.y) == (42.5, 20.0) and s.driver == "SERIAL_GRBL"
    await d.emergency_stop()
    assert fake.written[-1] == b"\x18" and not d.homed
    await d.disconnect()
    assert fake.closed


@pytest.mark.anyio
async def test_grbl_errors_alarms_and_missing_banner():
    fake = FakeGrbl(error_on="G90")
    d = SerialGantryDriver(lambda: fake, ack_timeout_s=1)
    await d.connect()
    await d.home()
    with pytest.raises(DriverFault, match="error:20"):
        await d.move_to(10, 10, 0.5)
    assert d.fault == "CONTROLLER_ERROR_20"
    alarm = FakeGrbl(alarm_on_home=True)
    d2 = SerialGantryDriver(lambda: alarm, ack_timeout_s=1)
    await d2.connect()
    with pytest.raises(DriverFault, match="ALARM"):
        await d2.home()
    assert not d2.homed
    mute = FakeGrbl(banner=False)
    d3 = SerialGantryDriver(lambda: mute, ack_timeout_s=0.2, banner_timeout_s=0.2)
    with pytest.raises(DriverFault, match="no GRBL banner"):
        await d3.connect()
    assert d3.fault == "NO_GRBL_BANNER" and not d3.connected


async def homed_controller(**kw):
    fake = FakeGrbl()
    d = SerialGantryDriver(lambda: fake, ack_timeout_s=1)
    m = MotionController(d, EventBus(), hardware=True, **kw)
    await m.connect()
    return fake, d, m


@pytest.mark.anyio
async def test_interlocks_block_unsafe_moves():
    fake, d, m = await homed_controller()
    with pytest.raises(InterlockError, match="not homed"):
        await m.move_to(10, 10, 0.5)
    await m.home()
    for x, y, sp, msg in [(150, 10, 0.5, "soft travel"), (10, -1, 0.5, "soft travel"), (math.nan, 10, 0.5, "non-finite"), (10, 10, 1.5, "speed"), (10, 10, 0.05, "speed")]:
        with pytest.raises(InterlockError, match=msg):
            await m.move_to(x, y, sp)
    await m.move_to(30, 15, 0.5)
    await m.emergency_stop()
    with pytest.raises(InterlockError, match="emergency stop"):
        await m.move_to(10, 10, 0.5)
    with pytest.raises(InterlockError, match="emergency stop"):
        await m.home()
    await m.clear_estop()
    with pytest.raises(InterlockError, match="not homed"):
        await m.move_to(10, 10, 0.5), "a soft-reset e-stop requires re-homing"
    await m.home()
    await m.move_to(10, 10, 0.5)


@pytest.mark.anyio
async def test_watchdog_stops_on_invalid_telemetry_alarm_and_lost_link():
    fake, d, m = await homed_controller(telemetry_timeout_s=0.3)
    await m.home()
    fake.x = 250.0  # controller reports a position far outside travel
    await m.check_once()
    assert m.estop and "INVALID_TELEMETRY" in m.fault and fake.written[-1] == b"\x18"

    fake, d, m = await homed_controller(telemetry_timeout_s=0.3)
    await m.home()
    fake.state = "Alarm"
    await m.check_once()
    assert m.estop and m.fault.startswith("UNEXPECTED_STATE")

    fake, d, m = await homed_controller(telemetry_timeout_s=0.2)
    await m.home()
    fake.silent = True
    m.last_ok -= 1.0
    await m.check_once()
    assert m.estop and m.fault.startswith("TELEMETRY_LOST")


@pytest.mark.anyio
async def test_watchdog_command_timeout_and_validation_of_status():
    m = MotionController(SimulatedGantryDriver(), EventBus(), hardware=False)
    base = dict(driver="SIMULATED", connected=True, homed=True, requires_homing=False, x=1, y=1, vx=0, vy=0, target_x=1, target_y=1, moving=False, limit_x=False, limit_y=False, state="Idle", fault=None, last_command=None, last_ack=None, updated_at=0)
    assert m.validate(GantryStatus(**base)) is None
    assert "non-finite" in m.validate(GantryStatus(**{**base, "vx": math.inf}))
    m.deadline = 0.0
    assert m.validate(GantryStatus(**{**base, "moving": True})).startswith("COMMAND_TIMEOUT")


@pytest.mark.anyio
async def test_simulated_driver_estop_is_immediate():
    d = SimulatedGantryDriver()
    m = MotionController(d, EventBus(), hardware=False)
    await m.move_to(90, 35, 1.0)
    d.advance(1.0)
    assert d.moving
    await m.emergency_stop()
    assert d.x.vel == 0 and d.y.vel == 0 and not d.moving
    here = (d.x.pos, d.y.pos)
    d.advance(1.0)
    assert (d.x.pos, d.y.pos) == here
