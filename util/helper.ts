import { NextFunction, Request, Response } from 'express'
import { redisClient } from "../config/redis"; 
const CACHE_TTL = 3600; // 1 hour

export const getGrade = (num: any,grades: any) => {
    if(num == null) return 'I'
    num = parseFloat(num)
    const vs = grades && grades.find((row: any) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max))
    console.log(num,vs)
    return (vs && vs.grade) || 'I';
}

export const getGradePoint = (num: any,grades: any) => {
    if(num == null) return 0
    num = parseFloat(num)
    const vs = grades && grades.find((row: any) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max))
    return (vs && vs.gradepoint) || 0;
}

export const getClass = (num: any,classes: any) => {
    if(num == null || classes == null ) return 'No Class'
    num = parseFloat(num)
    const vs = classes && classes.find((row: any) => parseFloat(row.min) <= parseFloat(num) && parseFloat(num) <= parseFloat(row.max))
    return (vs && vs.class) || 'No Class';
}

export const getBillCodePrisma = (semesterNum: number,) => {
   if([1,2].includes(semesterNum)) return [{ mainGroupCode: { contains: '1000' }},{ mainGroupCode: { contains: '1001' }},{ mainGroupCode: { contains: '1010' }},{ mainGroupCode: { contains: '1100' }},{ mainGroupCode: { contains: '1101' }},{ mainGroupCode: { contains: '1110' }},{ mainGroupCode: { contains: '1111' }}]
   if([3,4].includes(semesterNum)) return [{ mainGroupCode: { contains: '0100' }},{ mainGroupCode: { contains: '0101' }},{ mainGroupCode: { contains: '0110' }},{ mainGroupCode: { contains: '0111' }},{ mainGroupCode: { contains: '1111' }},{ mainGroupCode: { contains: '1110' }},{ mainGroupCode: { contains: '1100' }}]
   if([5,6].includes(semesterNum)) return [{ mainGroupCode: { contains: '0010' }},{ mainGroupCode: { contains: '0011' }},{ mainGroupCode: { contains: '1010' }},{ mainGroupCode: { contains: '1011' }},{ mainGroupCode: { contains: '1111' }},{ mainGroupCode: { contains: '0110' }},{ mainGroupCode: { contains: '0111' }}]
}

export const getSemesterFromCode = (semester: any, code: string,) => {
  const levels:any = code.split("");
  const lvs = [];
  if(levels.length){
     for(let i = 0; i < levels.length; i++){
        if(semester == 'SEM1'){
            if(levels[i] == 1 && i == 0) lvs.push(1)   
            if(levels[i] == 1  && i == 1) lvs.push(3)   
            if(levels[i] == 1  && i == 2) lvs.push(5)   
            if(levels[i] == 1  && i == 3) lvs.push(7)   
        } else {
            if(levels[i] == 1  && i == 0) lvs.push(2)   
            if(levels[i] == 1  && i == 1) lvs.push(4)   
            if(levels[i] == 1  && i == 2) lvs.push(6)   
            if(levels[i] == 1  && i == 3) lvs.push(8)
        }
     }
  }
  return lvs?.join(',');

}


export const decodeBase64Image = (dataString: any) => {
    var matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
    response:any = {};
    if (matches.length !== 3) return new Error('Invalid input string');
    response.type = matches[1];
    // response.data = new Buffer(matches[2], 'base64');
    response.data = Buffer.from(matches[2], 'base64');
    return response;
}


export const rotateImage = async (imageFile:any) => {
    const Jimp = require('jimp') ;
    // Reading Image
    const image = await Jimp.read(imageFile);
    // Checking if any error occurs while rotating image
    image.rotate(90, Jimp.RESIZE_BEZIER, function(err:any){
       if (err) throw err;
    }).write(imageFile);
}

export const apiLogger = (action: any) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        const api = req.query.api
        const refno = req.params.refno
        const dm = req.body
        let dt:any = {}
        if(refno) dt.studentId = refno
        if(api) dt.apiToken = api
        if(dm && Object.keys(dm).length > 0) dt.data = dm
        //const log = await SSO.apilogger(parseIp(req),action,dt)
        return next();
    }  
}

export const getOrSetCache = async (key: string, cb: () => Promise<any>) => {
    const cachedData = await redisClient.get(key);
    if (cachedData) {
       return JSON.parse(cachedData);
    }
    const freshData = await cb();
    if (freshData) {
       await redisClient.setEx(key, CACHE_TTL, JSON.stringify(freshData));
    }
    return freshData;
}

export const clearCache = async (key: string) =>  {
  const keys = await redisClient.keys(key);
  if (keys.length > 0) await redisClient.del(keys);
}

// Forms routinely submit "" for an untouched optional dropdown/input, or a
// literal sentinel like "NONE" for an explicit no-selection option — passed
// straight through as a scalar foreign key column, the DB rejects either as
// pointing to a row that doesn't exist. Stripping them lets Prisma omit the
// field (and MariaDB just store NULL) instead of erroring.
export const stripBlank = (body: any, blankValues: any[] = ['', 'NONE', null, undefined]) => {
  const clean: any = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (blankValues.includes(value)) continue;
    clean[key] = value;
  }
  return clean;
}

// Maps common Prisma error codes to plain-language messages safe to show a
// user, instead of the raw exception (SQL/driver internals, table/column
// names, stack frames) that error.message otherwise carries.
export const friendlyDbError = (error: any): string => {
  switch (error?.code) {
    case 'P2003':
      return `One of the values you selected doesn't exist or is no longer valid. Please re-check your selections and try again.`;
    case 'P2002': {
      const target = Array.isArray(error?.meta?.target) ? error.meta.target.join(', ') : error?.meta?.target;
      return `A record with this ${target || 'value'} already exists.`;
    }
    case 'P2025':
      return `The record you're trying to update or delete could not be found — it may have already been removed.`;
    case 'P2014':
      return `That change would leave a related record in an invalid state. Please review and try again.`;
    default:
      return `Something went wrong while saving. Please try again, and contact support if the problem continues.`;
  }
}