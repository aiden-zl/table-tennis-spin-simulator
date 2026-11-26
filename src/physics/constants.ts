/**
 * WORLD COORDINATES (metres, seconds, radians)
 *   +x : to the PLAYER's right (as seen from the player's end, looking at the opponent)
 *   +y : up
 *   +z : toward the PLAYER. Player's half of the table is z > 0, opponent's half z < 0.
 *   Net plane is z = 0. Table centre is (0, TABLE_Y, 0).
 *
 * SPIN (angular velocity vector w, rad/s, right-hand rule)
 *   For a ball travelling toward the player (+z):
 *     w.x > 0  => TOPSPIN   (dips in flight, kicks forward/low off the table)
 *     w.x < 0  => BACKSPIN  (floats in flight, checks up off the table)
 *     w.y > 0  => sidespin that CURVES toward +x (player's right)
 *     w.z      => corkscrew / gyro spin (axis along flight)
 *   For a ball travelling toward the opponent (-z) the topspin/backspin signs flip
 *   (topspin there is w.x < 0). Use spinFromComponents() in shotSolver to build vectors.
 */
export const G = 9.81;

// Ball (40+ ITTF ball)
export const BALL_RADIUS = 0.02;
export const BALL_MASS = 0.0027;
/** Thin spherical shell: I = 2/3 m R^2 */
export const BALL_INERTIA = (2 / 3) * BALL_MASS * BALL_RADIUS * BALL_RADIUS;
/** 1 + m R^2 / I : factor relating tangential impulse to contact-point velocity change */
export const TANGENTIAL_MASS_FACTOR = 1 + (BALL_MASS * BALL_RADIUS * BALL_RADIUS) / BALL_INERTIA; // 2.5

// Air
export const AIR_DENSITY = 1.2;
export const DRAG_COEFF = 0.5;
export const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
/** a_drag = -K_DRAG |v| v */
export const K_DRAG = (0.5 * AIR_DENSITY * DRAG_COEFF * BALL_AREA) / BALL_MASS;
/** Lift coefficient C_L = clamp(LIFT_SLOPE * spinRatio, 0, LIFT_MAX), spinRatio = R|w_perp|/|v|, w_perp = spin component perpendicular to v */
/**
 * LIFT_SLOPE tuned (was 1.0) so C_L ~ 0.24-0.40 for spin ratio S = 0.3-0.5, the target band
 * given for table-tennis balls. Not verified against primary data: published flight /
 * wind-tunnel work reports non-monotonic lift (a "lift crisis" near S ~ 0.5 and even negative
 * Magnus at high Re), which this linear-then-capped model does not represent.
 */
export const LIFT_SLOPE = 0.8;
export const LIFT_MAX = 0.55;
/** Exponential spin decay rate in flight (1/s) */
export const SPIN_DECAY = 0.04;

// Table (ITTF): 2.74 x 1.525, 0.76 high; net 15.25 cm high, overhangs 15.25 cm each side.
export const TABLE_Y = 0.76;
export const TABLE_HALF_LENGTH = 1.37;
export const TABLE_HALF_WIDTH = 0.7625;
export const TABLE_THICKNESS = 0.03;
export const NET_HEIGHT = 0.1525;
export const NET_HALF_WIDTH = TABLE_HALF_WIDTH + 0.1525;
/** tuned so a ball dropped from 30.5 cm rebounds ~24 cm (ITTF rule: 23-25 cm) */
export const TABLE_RESTITUTION = 0.915;
export const TABLE_FRICTION = 0.25;
export const FLOOR_Y = 0;

// Paddle (blade ~15 cm x 16 cm; modelled as an ellipse for coverage tests)
export const PADDLE_HALF_WIDTH = 0.075;
export const PADDLE_HALF_HEIGHT = 0.08;
export const PADDLE_RESTITUTION = 0.8;
/** Inverted rubber is very grippy */
export const PADDLE_FRICTION = 0.9;
/** Tangential elasticity of inverted rubber (sponge stores shear energy and returns some) */
export const PADDLE_TANGENTIAL_RESTITUTION = 0.15;

// Simulation
export const SIM_DT = 1 / 1000;
export const MAX_FRAME_DT = 1 / 20;

export const RPS_TO_RAD = 2 * Math.PI;
export const RAD_TO_RPS = 1 / RPS_TO_RAD;
export const DEG = Math.PI / 180;
