import { IPlugin, IModLoaderAPI, ModLoaderEvents } from 'modloader64_api/IModLoaderAPI';
import { bus } from 'modloader64_api/EventHandler';
import { OotOnlineEvents } from './OotoAPI/OotoAPI';
// import { EventHandler } from 'modloader64_api/EventHandler';
import { IOOTCore, LinkState } from 'modloader64_api/OOT/OOTAPI';
import { InjectCore } from 'modloader64_api/CoreInjection';
import { Z64RomTools } from 'Z64Lib/API/Z64RomTools'
// import { Z64LibEvents } from 'Z64Lib/API/Z64LibEvents';
import fse from 'fs-extra';
import path from 'path';

class zzdata {
  config_version!: string;
  config_file!: string;
  flip_jump_data!: string
  somersault_jump_data!: string
  somersault_land_data!: string
  anim_file!: string
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
  JUMP_SOMERSAULT = 0xDDDE,
  LAND_SOMERSAULT = 0xE532,
  LAND_REGULAR = 0x1B72E0,
}

const GAMEPLAY_KEEP_PTR = 0x8016A66C;

const enum GAMEPLAY_KEEP_OFFSETS {
  ANIM_JUMP = 0x3148,
  ANIM_LAND = 0x3150,
  ANIM_LAND_OTHER1 = 0x3168,
  ANIM_LAND_OTHER2 = 0x3170
}

const enum ANIM_LENGTHS {
  DEFAULT_JUMP = 0xD,
  DEFAULT_LAND = 0x10,
  SOMERSAULT_JUMP =  0xE,
  SOMERSAULT_LAND = 0x10
}

function getRandomInt(max: number) {
  return Math.floor(Math.random() * Math.floor(max));
}

function createAnimTableEntry(offset: number, frameCount: number) {
  let bankOffset1 = (offset >> 16) & 0xFF;
  let bankOffset2 = (offset >> 8) & 0xFF;
  let bankOffset3 = offset & 0xFF;
  let frameCount1 = frameCount >> 16 & 0xFF;
  let frameCount2 = frameCount & 0xFF;
  return Buffer.from([frameCount1, frameCount2, 0, 0, 7, bankOffset1, bankOffset2, bankOffset3]);
}

class zzplayas implements IPlugin {
  ModLoader!: IModLoaderAPI;
  pluginName?: string | undefined;
  @InjectCore()
  core!: IOOTCore;
  defaultWeight!: number;
  flipWeight!: number;
  somersaultWeight!: number;

  applyJumpSwap(animOffset: number) {
    var jumpLen;
    var landLen;
    var landOffset;

    if(animOffset === LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT) {
      jumpLen = ANIM_LENGTHS.SOMERSAULT_JUMP;
      landLen = ANIM_LENGTHS.SOMERSAULT_LAND;
      landOffset = LINK_ANIMETION_OFFSETS.LAND_SOMERSAULT;
    } else {
      jumpLen = ANIM_LENGTHS.DEFAULT_JUMP;
      landLen = ANIM_LENGTHS.DEFAULT_LAND;
      landOffset = LINK_ANIMETION_OFFSETS.LAND_REGULAR;
    }

    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP, createAnimTableEntry(animOffset, jumpLen));
    this.ModLoader.emulator.rdramWritePtrBuffer(GAMEPLAY_KEEP_PTR, GAMEPLAY_KEEP_OFFSETS.ANIM_LAND, createAnimTableEntry(landOffset, landLen));
    return jumpLen + landLen;
  }

  selectJumpRandomly() {
    let total = this.flipWeight + this.defaultWeight + this.somersaultWeight;

    let rng = getRandomInt(total) + 1;

    if(rng < this.defaultWeight) {
      return LINK_ANIMETION_OFFSETS.JUMP_REGULAR;
    }
    else if (rng < this.defaultWeight + this.flipWeight) {
      return LINK_ANIMETION_OFFSETS.JUMP_FLIP;
    }
    else return LINK_ANIMETION_OFFSETS.JUMP_SOMERSAULT;
  }

  createConfig(defaultWeight: number, rollWeight: number, somerWeight: number, configVersion: string, path: string) {
    fse.writeFileSync(path, JSON.stringify({config_version: configVersion, default_jump_weight: defaultWeight, rolling_jump_weight: rollWeight, somersault_jump_weight: somerWeight} as mm_jumps_options, null, 4));
  }

  /*
  loadAnim(evt: any, file: string, animetionOffset: number) {
    let tools: Z64RomTools = new Z64RomTools(this.ModLoader, 0x7430);
    let anims: Buffer = tools.decompressFileFromRom(evt, 7);
    let data: Buffer = fse.readFileSync(file);
    data.copy(anims, animetionOffset)
    tools.recompressFileIntoRom(evt, 7, anims);
  }
  */


  preinit(): void { }

  init(): void {
    let zz: zzdata = (this as any)['metadata']['zzplayas'];

    if (!fse.existsSync(zz.config_file)) {
      this.createConfig(70, 15, 15, zz.config_version, zz.config_file);
    }
    let config: mm_jumps_options = fse.readJSONSync(zz.config_file);

    /* Import settings when updating config file */
    if (config.config_version !== zz.config_version) {
      this.createConfig(config.default_jump_weight, config.rolling_jump_weight, config.somersault_jump_weight, zz.config_version, zz.config_file);
    }

    this.defaultWeight = config.default_jump_weight;
    this.flipWeight = config.rolling_jump_weight;
    this.somersaultWeight = config.somersault_jump_weight;

    bus.emit(OotOnlineEvents.CUSTOM_MODEL_APPLIED_ANIMATIONS, path.resolve(path.join(__dirname, zz.anim_file)));
  }
  postinit(): void { }

  onTick(): void { 
    if(this.core.helper.isPaused() || this.core.helper.isTitleScreen()) {
      return;
    }

    /* use regular jump if player is holding something */
    if(this.core.link.state === LinkState.HOLDING_ACTOR) {
      this.applyJumpSwap(LINK_ANIMETION_OFFSETS.JUMP_REGULAR);
    }
    else switch (this.core.link.get_anim_id()) {
      /* Don't update the jumping and landing animations while they're playing */
      case GAMEPLAY_KEEP_OFFSETS.ANIM_JUMP:
      case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND:
      case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_OTHER1:
      case GAMEPLAY_KEEP_OFFSETS.ANIM_LAND_OTHER2:
        break;
    
      default:
        this.applyJumpSwap(this.selectJumpRandomly());
        break;
    }
  }
}

module.exports = zzplayas;
