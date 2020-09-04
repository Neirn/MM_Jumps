import {IPlugin, IModLoaderAPI, ModLoaderEvents} from 'modloader64_api/IModLoaderAPI';
import {EventHandler} from 'modloader64_api/EventHandler'
import {IOOTCore} from 'modloader64_api/OOT/OOTAPI';
import {InjectCore} from 'modloader64_api/CoreInjection';
import {Z64RomTools} from 'Z64Lib/API/Z64RomTools';
import {Z64LibSupportedGames} from 'Z64Lib/API/Z64LibSupportedGames';
import { readJSONSync } from 'fs-extra';
import fs from 'fs';
import path from 'path';

class zzdata {
  config_version!: string;
  config_file!: string;
  jump_flip_anim!: string;
  land_flip_anim!: string;
  jump_somersault_anim!: string;
  land_somersault_anim!: string;
}

interface mm_jumps_options {
  config_version: string
  default_jump_weight: number
  rolling_jump_weight: number
  somersault_jump_weight: number
}

const enum LINK_ANIMETION_OFFSETS {
  JUMP_REGULAR = 0x1B4B00,
  JUMP_FLIP = 0xD710,
  LAND_REGULAR = 0x1B72E0,
  JUMP_SOMERSAULT = 0xDDDE,
  LAND_FLIP = 0xA1E80,
  LAND_SOMERSAULT = 0xA254E,
  FALL = 0x19D3E0,
  FALL_FREE = 0x19DEE0,
  LAND_SHORT = 0x1B72E0,
  LAND_SHORT_UNARMED = 0x1B7B40
}

const GAMEPLAY_KEEP_PTR = 0x8016A66C;

const enum GAMEPLAY_KEEP_OFFSETS {
  ANIM_JUMP = 0x3148,
  ANIM_LAND = 0x3150,
  ANIM_FALL_LAND = 0x3020,
  ANIM_FALL_LAND_UNARMED = 0x3028,
  ANIM_LAND_SHORT = 0x3168,
  ANIM_LAND_SHORT_UNARMED = 0x3170,
  ANIM_SHORT_JUMP = 0x2FD8,
  ANIM_SHORT_JUMP_LANDING = 0x2FE0,
  ANIM_NORMAL_LANDING_WAIT = 0x3040
}

const enum ANIM_LENGTHS {
  JUMP_DEFAULT = 0xD,
  LAND_DEFAULT = 0x10,
  LAND_DEFAULT_FALL = 0x15,
  JUMP_FLIP = 0xD,
  LAND_FLIP = 0xD,
  JUMP_SOMERSAULT =  0xE,
  LAND_SOMERSAULT = 0x10,
  LAND_DEFAULT_SHORT = 0x10,
  LAND_DEFAULT_SHORT_UNARMED = 0x10
}

function getRandomInt(max: number): number {
  return Math.floor(Math.random() * Math.floor(max));
}

function createAnimTableEntry(offset: number, frameCount: number): Buffer {
  let bankOffset1 = (offset >> 16) & 0xFF;
  let bankOffset2 = (offset >> 8) & 0xFF;
  let bankOffset3 = offset & 0xFF;
  let frameCount1 = frameCount >> 16 & 0xFF;
  let frameCount2 = frameCount & 0xFF;
  return Buffer.from([frameCount1, frameCount2, 0, 0, 7, bankOffset1, bankOffset2, bankOffset3]);
}

class main implements IPlugin {
  ModLoader!: IModLoaderAPI;
  pluginName?: string | undefined;
  @InjectCore()
  core!: IOOTCore;
  defaultWeight!: number;
  flipWeight!: number;
  somersaultWeight!: number;
  jumpInProgress: boolean = false;
  wasPaused: boolean = false;
  currentJump!: number;
  currentLanding!: number
  loadSuccess: boolean = false;

  applyJumpSwap(animOffset: number) {
    let jumpLen: number;

    switch (animOffset) {
      case LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT:
        jumpLen = ANIM_LENGTHS.JUMP_SOMERSAULT;
        break;

      case LINK_ANIMETION_OFFSETS.JUMP_FLIP:
        jumpLen = ANIM_LENGTHS.JUMP_FLIP;
        break;
    
      default:
        /* Just play the regular flip animation if the parameter isn't one of the two jumps */
        animOffset = LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
        jumpLen = ANIM_LENGTHS.JUMP_DEFAULT;
        break;
    }

    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP, createAnimTableEntry(animOffset, jumpLen));
    this.currentJump = animOffset;
  }

  applyLandingSwap(jumpOffset: number) {
    /* Set up parameters for default landing animation */
    let landLen: number = ANIM_LENGTHS.LAND_DEFAULT;
    let fallLen: number = ANIM_LENGTHS.LAND_DEFAULT_FALL;
    let landShortLen: number = ANIM_LENGTHS.LAND_DEFAULT_SHORT;
    let landShortUnarmedLen: number = ANIM_LENGTHS.LAND_DEFAULT_SHORT_UNARMED;
    let landOffset: number = LINK_ANIMETION_OFFSETS.LAND_REGULAR;
    let fallOffset: number = LINK_ANIMETION_OFFSETS.FALL;
    let fallFreeOffset: number = LINK_ANIMETION_OFFSETS.FALL_FREE;
    let landShortOffset: number = LINK_ANIMETION_OFFSETS.LAND_SHORT;
    let landShortUnarmedOffset: number = LINK_ANIMETION_OFFSETS.LAND_SHORT_UNARMED;

    /* Only swap from default during MM jump */
    let isMMJump: boolean = false;
    switch (jumpOffset) {
      case LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT:
        isMMJump = true;
        landLen = ANIM_LENGTHS.LAND_SOMERSAULT;
        landOffset = LINK_ANIMETION_OFFSETS.LAND_SOMERSAULT;
        break;

      case LINK_ANIMETION_OFFSETS.JUMP_FLIP:
        isMMJump = true;
        landLen = ANIM_LENGTHS.LAND_FLIP;
        landOffset = LINK_ANIMETION_OFFSETS.LAND_FLIP;
        break;
    
      default:
        break;
    }

    if(isMMJump) {
      fallLen = landLen;
      landShortLen = landLen;
      landShortUnarmedLen = landLen;
      fallOffset = landOffset;
      fallFreeOffset = landOffset;
      landShortOffset = landOffset;
      landShortUnarmedOffset = landOffset;
    }

    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND, createAnimTableEntry(landOffset, landLen));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND, createAnimTableEntry(fallOffset, fallLen));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND_UNARMED, createAnimTableEntry(fallFreeOffset, fallLen));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT, createAnimTableEntry(landShortOffset, landShortLen));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT_UNARMED, createAnimTableEntry(landShortUnarmedOffset, landShortUnarmedLen));
    this.currentLanding = landOffset;
  }

  selectJumpRandomly(): number {
    let total: number = this.flipWeight + this.defaultWeight + this.somersaultWeight;

    let rng: number = getRandomInt(total) + 1;

    if(rng < this.defaultWeight) {
      return LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
    }
    else if (rng < this.defaultWeight + this.flipWeight) {
      return LINK_ANIMETION_OFFSETS.JUMP_FLIP;
    }
    else return LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT;
  }

  createConfig(defaultWeight: number, rollWeight: number, somerWeight: number, configVersion: string, path: string): void {
    fs.writeFileSync(path, JSON.stringify({config_version: configVersion, default_jump_weight: defaultWeight, rolling_jump_weight: rollWeight, somersault_jump_weight: somerWeight} as mm_jumps_options, null, 4));
  }

  preinit(): void { }

  init(): void {
    let zz: zzdata = (this as any)['metadata']['configData'];

    /* Default chances of each jump */
    let defaultDefault: number = 34;
    let flipDefault: number = 33;
    let somersaultDefault: number = 33;

    if (!fs.existsSync(zz.config_file)) {
      try {
        this.createConfig(defaultDefault, flipDefault, somersaultDefault, zz.config_version, zz.config_file);
      } catch (error) {
        this.ModLoader.logger.warn("Couldn't generate config file!");
      }

    }
    try {
      let config: mm_jumps_options = readJSONSync(zz.config_file);
      /* Import settings when updating config file */
      if (config.config_version !== zz.config_version) {
        this.createConfig(config.default_jump_weight, config.rolling_jump_weight, config.somersault_jump_weight, zz.config_version, zz.config_file);
      }

      this.defaultWeight = config.default_jump_weight;
      this.flipWeight = config.rolling_jump_weight;
      this.somersaultWeight = config.somersault_jump_weight;
    } catch (error) {
      this.ModLoader.logger.warn("Error reading config file! Loading default values...")
      this.defaultWeight = defaultDefault;
      this.flipWeight = flipDefault;
      this.somersaultWeight = somersaultDefault;
    }

    /* Offset is vanilla before swapping any animations */
    this.currentJump = LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
    this.currentLanding = LINK_ANIMETION_OFFSETS.LAND_REGULAR;
  }

  postinit(): void { }

  onTick(): void { 
    if(this.loadSuccess) {
      if(this.core.helper.isPaused()) {
        this.wasPaused = true;
        return;
      }
  
      // restore the animation if the game was paused in the middle of a jump
      if(this.wasPaused) {
        this.applyJumpSwap(this.currentJump);
        this.applyLandingSwap(this.currentJump);
        this.wasPaused = false;
      }
  
      switch (this.core.link.get_anim_id()) {
  
        case GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP:
          /* Apply the correct landing animation to whatever jump is currently happening */
          if(!this.jumpInProgress) {
            this.applyLandingSwap(this.currentJump);
            this.jumpInProgress = true;
          }
          break;
  
        /* Don't update the jumping and landing animations while they're playing */
        case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_SHORT_UNARMED:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_FALL_LAND_UNARMED:
        case GAMEPLAY_KEEP_OFFSETS.ANIM_NORMAL_LANDING_WAIT:
          break;
      
        default:
          /* Choose next jump */
          this.applyJumpSwap(this.selectJumpRandomly());
  
          if(this.currentLanding !== LINK_ANIMETION_OFFSETS.LAND_REGULAR) {
            /* fix landing for backflips, ledge drops, etc when MM Jump not in progress */
            this.applyLandingSwap(LINK_ANIMETION_OFFSETS.JUMP_REGULAR);
          }
  
          this.jumpInProgress = false;
  
          break;
      }
    }
  }

  @EventHandler(ModLoaderEvents.ON_ROM_PATCHED_POST)
  onRomPatchedPost(evt: any): void {
    let linkAnimdma: number = 0x7;

    this.ModLoader.logger.info("Loading Majora's Mask Jump animations...");

    try {
      let zz: zzdata = (this as any)['metadata']['configData'];
      try {
        let tools: Z64RomTools = new Z64RomTools(this.ModLoader, Z64LibSupportedGames.OCARINA_OF_TIME);
        try {
          let animationData: Buffer = tools.decompressDMAFileFromRom(evt.rom, linkAnimdma);
          try {
            let jumpFlipBuff: Buffer = fs.readFileSync(path.resolve(path.join(__dirname, zz.jump_flip_anim)));
            let landFlipBuff: Buffer = fs.readFileSync(path.resolve(path.join(__dirname, zz.land_flip_anim)));
            let jumpSomerBuff: Buffer = fs.readFileSync(path.resolve(path.join(__dirname, zz.jump_somersault_anim)));
            let landSomerBuff: Buffer = fs.readFileSync(path.resolve(path.join(__dirname, zz.land_somersault_anim)));
            try {
              jumpFlipBuff.copy(animationData, LINK_ANIMETION_OFFSETS.JUMP_FLIP);
              landFlipBuff.copy(animationData, LINK_ANIMETION_OFFSETS.LAND_FLIP);
              jumpSomerBuff.copy(animationData, LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT);
              landSomerBuff.copy(animationData, LINK_ANIMETION_OFFSETS.LAND_SOMERSAULT);
              try {
                tools.recompressDMAFileIntoRom(evt.rom, linkAnimdma, animationData);
                this.ModLoader.logger.info("Majora's Mask jump animations loaded!");
                this.loadSuccess = true;
              } catch (error) {
                this.ModLoader.logger.error("Error re-injecting the animations to the ROM!");
                this.ModLoader.logger.error(error.message);
              }
            } catch (error) {
              this.ModLoader.logger.error("Error copying MM jumps to animation buffer!");
              this.ModLoader.logger.error(error.message);
            }
          } catch (error) {
            this.ModLoader.logger.error("Error reading Majora's Mask jump animation files!");
            this.ModLoader.logger.error(error.message);
          }
        } catch (error) {
          this.ModLoader.logger.error("Error extracting Link's animations from the ROM!")
          this.ModLoader.logger.error(error.message);
        }
      } catch (error) {
        this.ModLoader.logger.error("Z64Lib error! Is Z64Lib outdated?");
        this.ModLoader.logger.error(error.message);
      }
    } catch (error) {
      this.ModLoader.logger.error("Error loading metadata from package.json!");
      this.ModLoader.logger.error(error.message);
    }
  }
}

module.exports = main;